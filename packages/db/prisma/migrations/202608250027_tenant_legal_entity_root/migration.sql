BEGIN;

SELECT set_config('app.platform_context', 'on', true);

-- Upgrade migration 021 reconciliation: legal entities may be nested in the
-- organization hierarchy, but authorization_scope_nodes requires every
-- LEGAL_ENTITY scope to remain directly beneath the tenant scope.
CREATE OR REPLACE FUNCTION app.reconcile_organization_subtree_scopes(p_tenant uuid,p_root uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE item record; canonical_scope uuid; parent_scope uuid; link record; replacement_grant uuid; affected_memberships uuid[] := ARRAY[]::uuid[];
BEGIN
  FOR item IN
    SELECT n.id,n.parent_id,n.code,n.name,n.node_type,n.state,c.depth FROM app.organization_closure c
    JOIN app.organization_nodes n ON n.tenant_id=c.tenant_id AND n.id=c.descendant_id
    WHERE c.tenant_id=p_tenant AND c.ancestor_id=p_root ORDER BY c.depth,n.id
  LOOP
    IF item.node_type='LEGAL_ENTITY' THEN
      SELECT id INTO parent_scope FROM app.authorization_scope_nodes
        WHERE tenant_id=p_tenant AND scope_type='TENANT' AND status='ACTIVE'
        ORDER BY created_at,id LIMIT 1;
    ELSE
      SELECT authorization_scope_node_id INTO parent_scope FROM app.organization_nodes
        WHERE tenant_id=p_tenant AND id=item.parent_id;
    END IF;
    SELECT id INTO canonical_scope FROM app.authorization_scope_nodes
      WHERE tenant_id=p_tenant AND canonical_resource_id=item.id ORDER BY created_at DESC LIMIT 1;
    IF item.node_type IN ('LEGAL_ENTITY','REGION','BRANCH') AND canonical_scope IS NULL THEN
      INSERT INTO app.authorization_scope_nodes(tenant_id,scope_type,code,name,parent_id,canonical_resource_id,status)
      VALUES(p_tenant,item.node_type,'ORG-'||item.id::text,item.name,parent_scope,item.id,item.state)
      RETURNING id INTO canonical_scope;
    END IF;
    IF item.node_type IN ('LEGAL_ENTITY','REGION','BRANCH') THEN
      UPDATE app.authorization_scope_nodes SET scope_type=item.node_type,name=item.name,parent_id=parent_scope,status=item.state,updated_at=now(),version=version+1
        WHERE tenant_id=p_tenant AND id=canonical_scope AND (scope_type IS DISTINCT FROM item.node_type OR name IS DISTINCT FROM item.name OR parent_id IS DISTINCT FROM parent_scope OR status IS DISTINCT FROM item.state);
      UPDATE app.organization_nodes SET authorization_scope_node_id=canonical_scope,updated_at=now()
        WHERE tenant_id=p_tenant AND id=item.id AND authorization_scope_node_id IS DISTINCT FROM canonical_scope;
    ELSIF parent_scope IS NOT NULL THEN
      UPDATE app.authorization_scope_nodes SET status='INACTIVE',updated_at=now(),version=version+1
        WHERE tenant_id=p_tenant AND canonical_resource_id=item.id AND status='ACTIVE';
      UPDATE app.organization_nodes SET authorization_scope_node_id=parent_scope,updated_at=now()
        WHERE tenant_id=p_tenant AND id=item.id AND authorization_scope_node_id IS DISTINCT FROM parent_scope;
    END IF;
  END LOOP;

  UPDATE app.clients c SET authorization_scope_node_id=n.authorization_scope_node_id,updated_at=now(),version=c.version+1
  FROM app.organization_nodes n JOIN app.organization_closure oc ON oc.tenant_id=n.tenant_id AND oc.descendant_id=n.id
  WHERE c.tenant_id=p_tenant AND oc.ancestor_id=p_root AND c.tenant_id=n.tenant_id AND c.billing_entity_id=n.id
    AND c.authorization_scope_node_id IS DISTINCT FROM n.authorization_scope_node_id;
  UPDATE app.client_locations l SET authorization_scope_node_id=n.authorization_scope_node_id,updated_at=now(),version=l.version+1
  FROM app.organization_nodes n JOIN app.organization_closure oc ON oc.tenant_id=n.tenant_id AND oc.descendant_id=n.id
  WHERE l.tenant_id=p_tenant AND oc.ancestor_id=p_root AND l.tenant_id=n.tenant_id AND l.organization_node_id=n.id
    AND l.authorization_scope_node_id IS DISTINCT FROM n.authorization_scope_node_id;

  FOR link IN
    SELECT l.id,l.grant_id,g.assignment_id,a.membership_id,g.action,n.authorization_scope_node_id desired_scope
    FROM app.employee_scope_grant_links l
    JOIN app.scope_grants g ON g.tenant_id=l.tenant_id AND g.id=l.grant_id
    JOIN app.membership_role_assignments a ON a.tenant_id=g.tenant_id AND a.id=g.assignment_id
    JOIN app.organization_nodes n ON n.tenant_id=l.tenant_id AND n.id=l.organization_node_id
    JOIN app.organization_closure oc ON oc.tenant_id=n.tenant_id AND oc.descendant_id=n.id
    WHERE l.tenant_id=p_tenant AND l.state='ACTIVE' AND oc.ancestor_id=p_root
      AND g.scope_node_id IS DISTINCT FROM n.authorization_scope_node_id
  LOOP
    affected_memberships := array_append(affected_memberships,link.membership_id);
    INSERT INTO app.scope_grants(id,tenant_id,assignment_id,scope_node_id,action,status,effective_from)
    VALUES(gen_random_uuid(),p_tenant,link.assignment_id,link.desired_scope,link.action,'ACTIVE',now())
    ON CONFLICT(tenant_id,assignment_id,scope_node_id,action)
    DO UPDATE SET status='ACTIVE',effective_to=NULL,updated_at=now(),version=app.scope_grants.version+1
    RETURNING id INTO replacement_grant;
    UPDATE app.employee_scope_grant_links SET grant_id=replacement_grant WHERE tenant_id=p_tenant AND id=link.id;
    UPDATE app.scope_grants SET status='INACTIVE',effective_to=coalesce(effective_to,now()),updated_at=now(),version=version+1
      WHERE tenant_id=p_tenant AND id=link.grant_id
        AND NOT EXISTS(SELECT 1 FROM app.employee_scope_grant_links l WHERE l.tenant_id=p_tenant AND l.grant_id=link.grant_id AND l.state='ACTIVE');
  END LOOP;

  UPDATE app.tenant_memberships SET authorization_version=authorization_version+1,updated_at=now()
    WHERE tenant_id=p_tenant AND status='ACTIVE' AND id=ANY(affected_memberships);
END $$;

-- Repair policy: tenants may legitimately contain many legal entities. Select
-- one deterministic canonical company root, preserve every other legal entity,
-- and reconcile the complete organization/scope subtree beneath that root.
DO $$
DECLARE
  tenant_row record;
  actor_id uuid;
  tenant_scope_id uuid;
  legal_scope_id uuid;
  organization_id uuid;
  organization_code text;
  scope_code text;
  base_code text;
  suffix text;
  collision_number integer;
  organization_address text;
  tenant_timezone text;
  postal_code text;
  invariant_ok boolean;
BEGIN
  IF to_regprocedure('app.reconcile_organization_subtree_scopes(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Required function app.reconcile_organization_subtree_scopes(uuid,uuid) is missing'
      USING HINT = 'Apply migration 202608250021_mst01_exception_scope_reconciliation before this migration.';
  END IF;

  FOR tenant_row IN
    SELECT
      t.id,
      t.code AS tenant_code,
      t.legal_name,
      t.address,
      t.timezone,
      t.lifecycle_actor_id,
      le.code AS legal_entity_code,
      le.name AS legal_entity_name,
      candidate.id AS candidate_id,
      candidate.code AS candidate_code,
      candidate.authorization_scope_node_id AS candidate_scope_id
    FROM app.tenants t
    LEFT JOIN LATERAL (
      SELECT entity.code, entity.name
      FROM app.legal_entities entity
      WHERE entity.tenant_id = t.id
      ORDER BY entity.is_default DESC, entity.created_at, entity.id
      LIMIT 1
    ) le ON true
    LEFT JOIN LATERAL (
      SELECT node.id, node.code, node.authorization_scope_node_id
      FROM app.organization_nodes node
      WHERE node.tenant_id = t.id AND node.node_type = 'LEGAL_ENTITY'
      ORDER BY
        CASE
          WHEN node.state = 'ACTIVE' AND node.parent_id IS NULL
            AND (
              node.code = le.code OR
              lower(node.name) = lower(le.name)
            ) THEN 0
          WHEN node.state = 'ACTIVE' AND node.parent_id IS NULL THEN 1
          ELSE 2
        END,
        node.active_from,
        node.id
      LIMIT 1
    ) candidate ON true
    ORDER BY t.created_at, t.id
  LOOP
    SELECT coalesce(
      tenant_row.lifecycle_actor_id,
      (
        SELECT membership.user_id
        FROM app.tenant_memberships membership
        WHERE membership.tenant_id = tenant_row.id
          AND membership.user_id IS NOT NULL
          AND membership.status = 'ACTIVE'
        ORDER BY (membership.role = 'TENANT_OWNER') DESC, membership.created_at, membership.id
        LIMIT 1
      ),
      (
        SELECT membership.user_id
        FROM app.tenant_memberships membership
        WHERE membership.tenant_id = tenant_row.id AND membership.user_id IS NOT NULL
        ORDER BY (membership.role = 'TENANT_OWNER') DESC, membership.created_at, membership.id
        LIMIT 1
      ),
      (SELECT users.id FROM app.users users WHERE users.is_platform_admin ORDER BY users.created_at, users.id LIMIT 1),
      (SELECT users.id FROM app.users users ORDER BY users.created_at, users.id LIMIT 1)
    ) INTO actor_id;

    IF tenant_row.candidate_id IS NULL AND actor_id IS NULL THEN
      RAISE EXCEPTION
        'Cannot backfill LEGAL_ENTITY organization for tenant %: no attributable user exists', tenant_row.id
        USING HINT = 'Create or restore an attributable platform or tenant user, then rerun the migration.';
    END IF;

    tenant_timezone := coalesce(nullif(tenant_row.timezone, ''), 'Asia/Kolkata');
    postal_code := nullif(tenant_row.address ->> 'postalCode', '');
    organization_address := concat_ws(', ',
      nullif(tenant_row.address ->> 'line1', ''),
      nullif(tenant_row.address ->> 'line2', ''),
      nullif(tenant_row.address ->> 'locality', ''),
      nullif(tenant_row.address ->> 'city', ''),
      nullif(tenant_row.address ->> 'district', ''),
      nullif(tenant_row.address ->> 'region', ''),
      postal_code,
      nullif(tenant_row.address ->> 'country', '')
    );

    SELECT scope.id INTO tenant_scope_id
    FROM app.authorization_scope_nodes scope
    WHERE scope.tenant_id = tenant_row.id AND scope.scope_type = 'TENANT'
    ORDER BY (scope.status = 'ACTIVE') DESC, scope.created_at, scope.id
    LIMIT 1;

    IF tenant_scope_id IS NULL THEN
      INSERT INTO app.authorization_scope_nodes(tenant_id, scope_type, code, name)
      VALUES(tenant_row.id, 'TENANT', 'TENANT', 'Entire tenant')
      RETURNING id INTO tenant_scope_id;
    ELSE
      UPDATE app.authorization_scope_nodes
      SET status = 'ACTIVE', updated_at = now(), version = version + 1
      WHERE tenant_id = tenant_row.id AND id = tenant_scope_id AND status <> 'ACTIVE';
    END IF;

    IF tenant_row.candidate_id IS NULL THEN
      base_code := left(coalesce(nullif(tenant_row.legal_entity_code, ''), tenant_row.tenant_code), 30);
      organization_code := base_code;
      collision_number := 0;
      WHILE EXISTS (
        SELECT 1 FROM app.organization_nodes node
        WHERE node.tenant_id = tenant_row.id AND node.code = organization_code
      ) LOOP
        collision_number := collision_number + 1;
        suffix := '-LEGAL-' || collision_number::text;
        organization_code := left(base_code, greatest(1, 30 - length(suffix))) || suffix;
      END LOOP;

      INSERT INTO app.organization_nodes(
        tenant_id, code, name, node_type, timezone, address, postal_codes,
        active_from, state, created_by
      ) VALUES (
        tenant_row.id,
        organization_code,
        coalesce(nullif(tenant_row.legal_entity_name, ''), tenant_row.legal_name),
        'LEGAL_ENTITY',
        tenant_timezone,
        nullif(organization_address, ''),
        CASE WHEN postal_code IS NULL THEN ARRAY[]::text[] ELSE ARRAY[postal_code]::text[] END,
        (clock_timestamp() AT TIME ZONE tenant_timezone)::date,
        'ACTIVE',
        actor_id
      )
      RETURNING id INTO organization_id;
    ELSE
      organization_id := tenant_row.candidate_id;
      organization_code := tenant_row.candidate_code;
      UPDATE app.organization_nodes
      SET
        parent_id = NULL,
        state = 'ACTIVE',
        active_to = NULL,
        timezone = coalesce(nullif(timezone, ''), tenant_timezone),
        address = coalesce(address, nullif(organization_address, '')),
        postal_codes = CASE
          WHEN cardinality(postal_codes) = 0 AND postal_code IS NOT NULL THEN ARRAY[postal_code]::text[]
          ELSE postal_codes
        END,
        updated_at = now(),
        version = version + 1
      WHERE tenant_id = tenant_row.id
        AND id = organization_id
        AND (
          parent_id IS NOT NULL OR state <> 'ACTIVE' OR active_to IS NOT NULL OR
          timezone = '' OR (address IS NULL AND organization_address <> '') OR
          (cardinality(postal_codes) = 0 AND postal_code IS NOT NULL)
        );
    END IF;

    -- Adopt all former parallel top-level nodes beneath the canonical root.
    UPDATE app.organization_nodes
    SET parent_id = organization_id, updated_at = now(), version = version + 1
    WHERE tenant_id = tenant_row.id AND id <> organization_id AND parent_id IS NULL;

    legal_scope_id := NULL;
    IF tenant_row.candidate_scope_id IS NOT NULL THEN
      SELECT scope.id INTO legal_scope_id
      FROM app.authorization_scope_nodes scope
      WHERE scope.tenant_id = tenant_row.id
        AND scope.id = tenant_row.candidate_scope_id
        AND scope.scope_type = 'LEGAL_ENTITY'
        AND (scope.canonical_resource_id IS NULL OR scope.canonical_resource_id = organization_id)
        AND NOT EXISTS (
          SELECT 1 FROM app.organization_nodes other_node
          WHERE other_node.tenant_id = tenant_row.id
            AND other_node.id <> organization_id
            AND other_node.node_type IN ('LEGAL_ENTITY','REGION','BRANCH')
            AND other_node.authorization_scope_node_id = scope.id
        );
    END IF;
    IF legal_scope_id IS NULL THEN
      SELECT scope.id INTO legal_scope_id
      FROM app.authorization_scope_nodes scope
      WHERE scope.tenant_id = tenant_row.id
        AND scope.scope_type = 'LEGAL_ENTITY'
        AND scope.canonical_resource_id = organization_id
        AND NOT EXISTS (
          SELECT 1 FROM app.organization_nodes other_node
          WHERE other_node.tenant_id = tenant_row.id
            AND other_node.id <> organization_id
            AND other_node.node_type IN ('LEGAL_ENTITY','REGION','BRANCH')
            AND other_node.authorization_scope_node_id = scope.id
        )
      ORDER BY (scope.status = 'ACTIVE') DESC, scope.created_at, scope.id
      LIMIT 1;
    END IF;
    IF legal_scope_id IS NULL THEN
      SELECT scope.id INTO legal_scope_id
      FROM app.authorization_scope_nodes scope
      WHERE scope.tenant_id = tenant_row.id
        AND scope.scope_type = 'LEGAL_ENTITY'
        AND scope.code = organization_code
        AND (scope.canonical_resource_id IS NULL OR scope.canonical_resource_id = organization_id)
        AND NOT EXISTS (
          SELECT 1 FROM app.organization_nodes other_node
          WHERE other_node.tenant_id = tenant_row.id
            AND other_node.id <> organization_id
            AND other_node.node_type IN ('LEGAL_ENTITY','REGION','BRANCH')
            AND other_node.authorization_scope_node_id = scope.id
        )
      ORDER BY (scope.status = 'ACTIVE') DESC, scope.created_at, scope.id
      LIMIT 1;
    END IF;
    IF legal_scope_id IS NULL THEN
      base_code := left(organization_code, 30);
      scope_code := base_code;
      collision_number := 0;
      WHILE EXISTS (
        SELECT 1 FROM app.authorization_scope_nodes scope
        WHERE scope.tenant_id = tenant_row.id
          AND scope.scope_type = 'LEGAL_ENTITY'
          AND scope.code = scope_code
      ) LOOP
        collision_number := collision_number + 1;
        suffix := '-SCOPE-' || collision_number::text;
        scope_code := left(base_code, greatest(1, 30 - length(suffix))) || suffix;
      END LOOP;
      INSERT INTO app.authorization_scope_nodes(
        tenant_id, scope_type, code, name, parent_id, canonical_resource_id
      ) VALUES (
        tenant_row.id,
        'LEGAL_ENTITY',
        scope_code,
        coalesce(nullif(tenant_row.legal_entity_name, ''), tenant_row.legal_name),
        tenant_scope_id,
        organization_id
      )
      RETURNING id INTO legal_scope_id;
    ELSE
      UPDATE app.authorization_scope_nodes
      SET
        name = coalesce(nullif(tenant_row.legal_entity_name, ''), tenant_row.legal_name),
        parent_id = tenant_scope_id,
        canonical_resource_id = organization_id,
        status = 'ACTIVE',
        updated_at = now(),
        version = version + 1
      WHERE tenant_id = tenant_row.id
        AND id = legal_scope_id
        AND (
          name IS DISTINCT FROM coalesce(nullif(tenant_row.legal_entity_name, ''), tenant_row.legal_name) OR
          parent_id IS DISTINCT FROM tenant_scope_id OR
          canonical_resource_id IS DISTINCT FROM organization_id OR status <> 'ACTIVE'
        );
    END IF;

    UPDATE app.organization_nodes
    SET authorization_scope_node_id = legal_scope_id, updated_at = now(), version = version + 1
    WHERE tenant_id = tenant_row.id AND id = organization_id
      AND authorization_scope_node_id IS DISTINCT FROM legal_scope_id;

    -- Preserve usable legacy scopes by making an unbound, correctly typed,
    -- non-shared node scope canonical to that node. Invalid/shared references
    -- are detached from the organization (the scope and its grants remain) so
    -- migration 021 can safely select or create an independent canonical scope.
    UPDATE app.authorization_scope_nodes scope
    SET canonical_resource_id = node.id, updated_at = now(), version = scope.version + 1
    FROM app.organization_nodes node
    WHERE node.tenant_id = tenant_row.id
      AND node.node_type IN ('LEGAL_ENTITY','REGION','BRANCH')
      AND scope.tenant_id = node.tenant_id
      AND scope.id = node.authorization_scope_node_id
      AND scope.scope_type = node.node_type
      AND scope.canonical_resource_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM app.organization_nodes other_node
        WHERE other_node.tenant_id = node.tenant_id
          AND other_node.id <> node.id
          AND other_node.node_type IN ('LEGAL_ENTITY','REGION','BRANCH')
          AND other_node.authorization_scope_node_id = scope.id
      );

    UPDATE app.organization_nodes node
    SET authorization_scope_node_id = NULL, updated_at = now(), version = node.version + 1
    FROM app.authorization_scope_nodes scope
    WHERE node.tenant_id = tenant_row.id
      AND node.id <> organization_id
      AND node.node_type IN ('LEGAL_ENTITY','REGION','BRANCH')
      AND scope.tenant_id = node.tenant_id
      AND scope.id = node.authorization_scope_node_id
      AND (
        scope.scope_type IS DISTINCT FROM node.node_type OR
        scope.canonical_resource_id IS DISTINCT FROM node.id OR
        EXISTS (
          SELECT 1 FROM app.organization_nodes other_node
          WHERE other_node.tenant_id = node.tenant_id
            AND other_node.id <> node.id
            AND other_node.node_type IN ('LEGAL_ENTITY','REGION','BRANCH')
            AND other_node.authorization_scope_node_id = scope.id
        )
      );

    UPDATE app.authorization_scope_nodes scope
    SET canonical_resource_id = NULL, updated_at = now(), version = scope.version + 1
    WHERE scope.tenant_id = tenant_row.id
      AND scope.canonical_resource_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM app.organization_nodes canonical_node
        WHERE canonical_node.tenant_id = tenant_row.id
          AND canonical_node.id = scope.canonical_resource_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.organization_nodes referencing_node
        WHERE referencing_node.tenant_id = tenant_row.id
          AND referencing_node.node_type IN ('LEGAL_ENTITY','REGION','BRANCH')
          AND referencing_node.authorization_scope_node_id = scope.id
      );

    UPDATE app.authorization_scope_nodes scope
    SET canonical_resource_id = NULL, updated_at = now(), version = version + 1
    WHERE scope.tenant_id = tenant_row.id
      AND scope.scope_type = 'LEGAL_ENTITY'
      AND scope.canonical_resource_id = organization_id
      AND scope.id <> legal_scope_id;

    -- Refuse to manufacture closure rows from a cyclic source hierarchy.
    IF EXISTS (
      WITH RECURSIVE walk(start_id, current_id, parent_id, path, cycle) AS (
        SELECT node.id, node.id, node.parent_id, ARRAY[node.id]::uuid[], false
        FROM app.organization_nodes node WHERE node.tenant_id = tenant_row.id
        UNION ALL
        SELECT walk.start_id, parent.id, parent.parent_id, walk.path || parent.id,
               parent.id = ANY(walk.path)
        FROM walk
        JOIN app.organization_nodes parent
          ON parent.tenant_id = tenant_row.id AND parent.id = walk.parent_id
        WHERE NOT walk.cycle
      )
      SELECT 1 FROM walk WHERE cycle LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Organization hierarchy cycle detected for tenant %', tenant_row.id
        USING HINT = 'Repair organization_nodes.parent_id relationships, then rerun the migration.';
    END IF;

    DELETE FROM app.organization_closure WHERE tenant_id = tenant_row.id;
    INSERT INTO app.organization_closure(tenant_id, ancestor_id, descendant_id, depth)
    WITH RECURSIVE closure_rows(ancestor_id, descendant_id, depth, path) AS (
      SELECT node.id, node.id, 0, ARRAY[node.id]::uuid[]
      FROM app.organization_nodes node WHERE node.tenant_id = tenant_row.id
      UNION ALL
      SELECT parent.id, closure_rows.descendant_id, closure_rows.depth + 1,
             closure_rows.path || parent.id
      FROM closure_rows
      JOIN app.organization_nodes current_node
        ON current_node.tenant_id = tenant_row.id AND current_node.id = closure_rows.ancestor_id
      JOIN app.organization_nodes parent
        ON parent.tenant_id = tenant_row.id AND parent.id = current_node.parent_id
      WHERE NOT parent.id = ANY(closure_rows.path)
    )
    SELECT tenant_row.id, ancestor_id, descendant_id, depth FROM closure_rows;

    -- Migration 021 owns the canonical subtree authorization-scope repair,
    -- including REGION/BRANCH creation/reparenting and dependent grant links.
    PERFORM app.reconcile_organization_subtree_scopes(tenant_row.id, organization_id);

    -- Keep the selected root binding explicit after subtree reconciliation.
    UPDATE app.authorization_scope_nodes
    SET parent_id = tenant_scope_id, canonical_resource_id = organization_id,
        status = 'ACTIVE', updated_at = now(), version = version + 1
    WHERE tenant_id = tenant_row.id
      AND id = legal_scope_id
      AND (
        parent_id IS DISTINCT FROM tenant_scope_id OR
        canonical_resource_id IS DISTINCT FROM organization_id OR
        status <> 'ACTIVE'
      );

    -- The reconciliation function chooses the canonical scope recorded on each
    -- node. Detach any older unreferenced canonical markers so every scoped
    -- organization has exactly one canonical binding.
    UPDATE app.authorization_scope_nodes scope
    SET canonical_resource_id = NULL, updated_at = now(), version = scope.version + 1
    FROM app.organization_nodes node
    WHERE node.tenant_id = tenant_row.id
      AND node.node_type IN ('LEGAL_ENTITY','REGION','BRANCH')
      AND scope.tenant_id = node.tenant_id
      AND scope.canonical_resource_id = node.id
      AND scope.id <> node.authorization_scope_node_id;

    SELECT
      EXISTS (
        SELECT 1
        FROM app.organization_nodes root
        JOIN app.authorization_scope_nodes scope
          ON scope.tenant_id = root.tenant_id AND scope.id = root.authorization_scope_node_id
        WHERE root.tenant_id = tenant_row.id
          AND root.id = organization_id
          AND root.node_type = 'LEGAL_ENTITY'
          AND root.parent_id IS NULL
          AND root.state = 'ACTIVE'
          AND scope.scope_type = 'LEGAL_ENTITY'
          AND scope.parent_id = tenant_scope_id
          AND scope.canonical_resource_id = root.id
          AND (
            SELECT count(*) FROM app.authorization_scope_nodes canonical_scope
            WHERE canonical_scope.tenant_id = tenant_row.id
              AND canonical_scope.scope_type = 'LEGAL_ENTITY'
              AND canonical_scope.canonical_resource_id = root.id
          ) = 1
          AND (
            SELECT count(*) FROM app.organization_nodes scope_reference
            WHERE scope_reference.tenant_id = tenant_row.id
              AND scope_reference.authorization_scope_node_id = scope.id
              AND scope_reference.node_type IN ('LEGAL_ENTITY','REGION','BRANCH')
          ) = 1
      )
      AND (
        SELECT count(*) FROM app.organization_nodes active_root
        WHERE active_root.tenant_id = tenant_row.id
          AND active_root.parent_id IS NULL
          AND active_root.state = 'ACTIVE'
      ) = 1
      AND NOT EXISTS (
        SELECT 1 FROM app.organization_nodes top_level
        WHERE top_level.tenant_id = tenant_row.id
          AND top_level.id <> organization_id AND top_level.parent_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.organization_nodes descendant
        WHERE descendant.tenant_id = tenant_row.id
          AND NOT EXISTS (
            SELECT 1 FROM app.organization_closure closure
            WHERE closure.tenant_id = tenant_row.id
              AND closure.ancestor_id = organization_id
              AND closure.descendant_id = descendant.id
          )
      )
    INTO invariant_ok;

    invariant_ok := coalesce(invariant_ok, false) AND NOT EXISTS (
      SELECT 1
      FROM app.organization_nodes node
      JOIN app.organization_nodes parent_node
        ON parent_node.tenant_id = node.tenant_id AND parent_node.id = node.parent_id
      LEFT JOIN app.authorization_scope_nodes node_scope
        ON node_scope.tenant_id = node.tenant_id AND node_scope.id = node.authorization_scope_node_id
      WHERE node.tenant_id = tenant_row.id
        AND node.node_type IN ('REGION','BRANCH')
        AND (
          node_scope.id IS NULL OR
          node_scope.scope_type IS DISTINCT FROM node.node_type OR
          node_scope.canonical_resource_id IS DISTINCT FROM node.id OR
          node_scope.parent_id IS DISTINCT FROM parent_node.authorization_scope_node_id OR
          (SELECT count(*) FROM app.authorization_scope_nodes canonical_scope
           WHERE canonical_scope.tenant_id = node.tenant_id
             AND canonical_scope.scope_type = node.node_type
             AND canonical_scope.canonical_resource_id = node.id) <> 1
        )
    );

    invariant_ok := coalesce(invariant_ok, false) AND NOT EXISTS (
      SELECT 1
      FROM app.organization_nodes node
      LEFT JOIN app.authorization_scope_nodes node_scope
        ON node_scope.tenant_id = node.tenant_id AND node_scope.id = node.authorization_scope_node_id
      WHERE node.tenant_id = tenant_row.id
        AND node.node_type = 'LEGAL_ENTITY'
        AND node.id <> organization_id
        AND (
          node_scope.id IS NULL OR
          node_scope.scope_type IS DISTINCT FROM 'LEGAL_ENTITY' OR
          node_scope.canonical_resource_id IS DISTINCT FROM node.id OR
          node_scope.parent_id IS DISTINCT FROM tenant_scope_id OR
          (SELECT count(*) FROM app.authorization_scope_nodes canonical_scope
           WHERE canonical_scope.tenant_id = node.tenant_id
             AND canonical_scope.scope_type = 'LEGAL_ENTITY'
             AND canonical_scope.canonical_resource_id = node.id) <> 1
        )
    );

    invariant_ok := coalesce(invariant_ok, false) AND NOT EXISTS (
      SELECT 1
      FROM app.organization_nodes node
      JOIN app.organization_nodes parent_node
        ON parent_node.tenant_id = node.tenant_id AND parent_node.id = node.parent_id
      WHERE node.tenant_id = tenant_row.id
        AND node.node_type IN ('TEAM','HUB')
        AND node.authorization_scope_node_id IS DISTINCT FROM parent_node.authorization_scope_node_id
    );

    IF NOT coalesce(invariant_ok, false) THEN
      RAISE EXCEPTION 'Canonical LEGAL_ENTITY root invariant failed for tenant %', tenant_row.id
        USING HINT = 'Inspect organization nodes, closure rows, and authorization scope bindings before rerunning.';
    END IF;

    -- Complete only after root, scope, adoption and closure invariants pass.
    INSERT INTO app.setup_checklist_items(
      tenant_id, key, label, display_order, state, completed_by, completed_at
    ) VALUES (
      tenant_row.id, 'organization', 'Organization', 1, 'COMPLETE', actor_id, now()
    )
    ON CONFLICT (tenant_id, key) DO UPDATE
    SET
      state = 'COMPLETE',
      completed_by = coalesce(EXCLUDED.completed_by, setup_checklist_items.completed_by),
      completed_at = coalesce(setup_checklist_items.completed_at, EXCLUDED.completed_at),
      updated_at = CASE WHEN setup_checklist_items.state <> 'COMPLETE' THEN now() ELSE setup_checklist_items.updated_at END,
      version = CASE WHEN setup_checklist_items.state <> 'COMPLETE' THEN setup_checklist_items.version + 1 ELSE setup_checklist_items.version END;
  END LOOP;
END $$;

COMMIT;
