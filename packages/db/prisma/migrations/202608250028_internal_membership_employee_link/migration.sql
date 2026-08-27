BEGIN;
SELECT set_config('app.platform_context','on',true);

-- Preserve the best existing one-to-one link and release only duplicate links;
-- employee rows themselves are never deleted by this repair.
WITH ranked AS (
  SELECT id,row_number() OVER (
    PARTITION BY tenant_id,linked_membership_id
    ORDER BY (state='ACTIVE') DESC,active_from,id
  ) position
  FROM app.employees
  WHERE linked_membership_id IS NOT NULL
)
UPDATE app.employees employee
SET linked_membership_id=NULL,updated_at=now(),version=employee.version+1
FROM ranked
WHERE employee.id=ranked.id AND ranked.position>1;

-- A pre-existing explicit FK is migration confirmation only when it is active,
-- tenant-local, unambiguous, and supported by a normalized destination match.
-- Runtime invitation matching remains strict and never uses this repair rule.
DO $$
DECLARE
  linked record;
  migration_actor uuid;
  before_snapshot jsonb;
  after_snapshot jsonb;
BEGIN
  SELECT id INTO migration_actor FROM app.users
  WHERE is_platform_admin AND status='ACTIVE'
  ORDER BY created_at,id LIMIT 1;
  FOR linked IN
    SELECT employee.id employee_id,employee.tenant_id,
      membership.id membership_id,membership.employee_code,
      membership.invited_name,membership.invited_email,membership.invited_mobile
    FROM app.employees employee
    JOIN app.tenant_memberships membership
      ON membership.tenant_id=employee.tenant_id AND membership.id=employee.linked_membership_id
    WHERE membership.portal_audience='INTERNAL'
      AND membership.status='ACTIVE' AND employee.state='ACTIVE'
      AND employee.employee_code IS DISTINCT FROM membership.employee_code
      AND (
        (membership.invited_email IS NOT NULL AND employee.email IS NOT NULL AND
          lower(trim(employee.email))=lower(trim(membership.invited_email))) OR
        (membership.invited_mobile IS NOT NULL AND employee.mobile IS NOT NULL AND
          regexp_replace(employee.mobile,'[^0-9+]','','g')=
          regexp_replace(membership.invited_mobile,'[^0-9+]','','g'))
      )
      AND (membership.invited_email IS NULL OR employee.email IS NULL OR
        lower(trim(employee.email))=lower(trim(membership.invited_email)))
      AND (membership.invited_mobile IS NULL OR employee.mobile IS NULL OR
        regexp_replace(employee.mobile,'[^0-9+]','','g')=
        regexp_replace(membership.invited_mobile,'[^0-9+]','','g'))
      AND NOT EXISTS(
        SELECT 1 FROM app.employees other
        WHERE other.tenant_id=employee.tenant_id AND other.id<>employee.id AND (
          other.employee_code=membership.employee_code OR
          (membership.invited_email IS NOT NULL AND other.email IS NOT NULL AND
            lower(trim(other.email))=lower(trim(membership.invited_email))) OR
          (membership.invited_mobile IS NOT NULL AND other.mobile IS NOT NULL AND
            regexp_replace(other.mobile,'[^0-9+]','','g')=
            regexp_replace(membership.invited_mobile,'[^0-9+]','','g'))
        )
      )
    ORDER BY employee.tenant_id,membership.created_at,membership.id,employee.id
    FOR UPDATE OF employee,membership
  LOOP
    IF migration_actor IS NULL THEN
      RAISE EXCEPTION 'Explicit Employee link reconciliation requires an active platform administrator migration actor';
    END IF;
    SELECT jsonb_build_object(
      'employeeCode',employee_code,'displayName',display_name,
      'hasEmail',email IS NOT NULL,'hasMobile',mobile IS NOT NULL,
      'membershipId',linked_membership_id
    ) INTO before_snapshot FROM app.employees
    WHERE tenant_id=linked.tenant_id AND id=linked.employee_id;
    UPDATE app.employees SET
      employee_code=linked.employee_code,display_name=linked.invited_name,
      email=coalesce(linked.invited_email,email),
      mobile=coalesce(linked.invited_mobile,mobile),
      updated_at=now(),version=version+1
    WHERE tenant_id=linked.tenant_id AND id=linked.employee_id;
    SELECT jsonb_build_object(
      'employeeCode',employee_code,'displayName',display_name,
      'hasEmail',email IS NOT NULL,'hasMobile',mobile IS NOT NULL,
      'membershipId',linked_membership_id
    ) INTO after_snapshot FROM app.employees
    WHERE tenant_id=linked.tenant_id AND id=linked.employee_id;
    INSERT INTO audit.audit_events(
      tenant_id,actor_id,action,target_type,target_id,correlation_id,before_json,after_json,reason
    ) VALUES(
      linked.tenant_id,migration_actor,'migration.identity.employee.link.confirmed',
      'employee',linked.employee_id,'migration-028-explicit-employee-link',
      before_snapshot,after_snapshot,
      'Preserved active explicit membership link after unique normalized destination confirmation'
    );
    INSERT INTO app.outbox_events(
      tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key
    ) VALUES(
      linked.tenant_id,'TENANT','employee',linked.employee_id,
      'identity.employee.link.confirmed.v1',
      jsonb_build_object('employeeId',linked.employee_id,'membershipId',linked.membership_id,
        'reason','MIGRATION_EXPLICIT_FK_CONFIRMED'),
      'migration-028-explicit-employee-link:'||linked.tenant_id::text||':'||linked.membership_id::text
    ) ON CONFLICT(deduplication_key) DO NOTHING;
  END LOOP;
END $$;

-- Unconfirmed mismatches are detached; strict backfill will then either create
-- safely or fail with an actionable reconciliation error.
UPDATE app.employees employee
SET linked_membership_id=NULL,updated_at=now(),version=employee.version+1
FROM app.tenant_memberships membership
WHERE employee.tenant_id=membership.tenant_id
  AND employee.linked_membership_id=membership.id
  AND (
    membership.portal_audience<>'INTERNAL' OR
    employee.employee_code IS DISTINCT FROM membership.employee_code
  );

CREATE OR REPLACE FUNCTION app.resolve_tenant_attributable_actor(
  p_tenant uuid,
  p_candidates uuid[]
) RETURNS uuid LANGUAGE sql STABLE AS $$
  WITH candidates AS (
    SELECT candidate.id,candidate.ordinality
    FROM unnest(p_candidates) WITH ORDINALITY candidate(id,ordinality)
    WHERE candidate.id IS NOT NULL
    UNION ALL
    SELECT tenant.lifecycle_actor_id,1000
    FROM app.tenants tenant
    WHERE tenant.id=p_tenant AND tenant.lifecycle_actor_id IS NOT NULL
    UNION ALL
    SELECT fallback.user_id,2000
    FROM LATERAL (
      SELECT membership.user_id
      FROM app.tenant_memberships membership
      WHERE membership.tenant_id=p_tenant
        AND membership.status='ACTIVE'
        AND membership.user_id IS NOT NULL
      ORDER BY EXISTS(
        SELECT 1
        FROM app.membership_role_assignments assignment
        JOIN app.roles role
          ON role.tenant_id=assignment.tenant_id AND role.id=assignment.role_id
        WHERE assignment.tenant_id=membership.tenant_id
          AND assignment.membership_id=membership.id
          AND assignment.status='ACTIVE'
          AND assignment.effective_from<=now()
          AND (assignment.effective_to IS NULL OR assignment.effective_to>now())
          AND role.status='ACTIVE' AND role.code='TENANT_OWNER'
      ) DESC,membership.created_at,membership.id
      LIMIT 1
    ) fallback
  )
  SELECT candidate.id
  FROM candidates candidate
  JOIN app.users actor ON actor.id=candidate.id
  LEFT JOIN app.tenants tenant ON tenant.id=p_tenant
  WHERE actor.is_platform_admin
     OR candidate.id=tenant.lifecycle_actor_id
     OR EXISTS(
       SELECT 1 FROM app.tenant_memberships membership
       WHERE membership.tenant_id=p_tenant AND membership.user_id=candidate.id
     )
  ORDER BY candidate.ordinality
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.ensure_internal_membership_employee(
  p_tenant uuid,
  p_membership uuid,
  p_actor uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  membership_row record;
  employee_id uuid;
  root_id uuid;
  root_count integer;
  actor_id uuid;
  link_changed boolean := false;
  conflicting_employee_id uuid;
  conflicting_employee_code text;
BEGIN
  SELECT * INTO membership_row
  FROM app.tenant_memberships
  WHERE tenant_id=p_tenant AND id=p_membership
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant membership not found'; END IF;
  IF membership_row.portal_audience<>'INTERNAL' THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant::text||':membership-employee:'||membership_row.employee_code,0
  ));

  SELECT employee.id,employee.employee_code
  INTO conflicting_employee_id,conflicting_employee_code
  FROM app.employees employee
    WHERE employee.tenant_id=p_tenant
      AND employee.employee_code<>membership_row.employee_code
      AND (
        (membership_row.invited_email IS NOT NULL AND employee.email IS NOT NULL AND
          lower(trim(employee.email))=lower(trim(membership_row.invited_email))) OR
        (membership_row.invited_mobile IS NOT NULL AND employee.mobile IS NOT NULL AND
          regexp_replace(employee.mobile,'[^0-9+]','','g')=
          regexp_replace(membership_row.invited_mobile,'[^0-9+]','','g'))
      )
  ORDER BY employee.id
  LIMIT 1
  FOR UPDATE;
  IF conflicting_employee_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE=format(
        'EMPLOYEE_LINK_CONFIRMATION_REQUIRED: tenant %s membership %s (%s) destination belongs to employee %s (%s)',
        p_tenant,p_membership,membership_row.employee_code,
        conflicting_employee_id,conflicting_employee_code
      ),
      HINT='Reconcile the Employee code/destination through the governed tenant identity workflow, then rerun the migration; no data was changed.';
  END IF;

  SELECT id INTO employee_id FROM app.employees
  WHERE tenant_id=p_tenant AND linked_membership_id=p_membership
  ORDER BY (state='ACTIVE') DESC,active_from,id LIMIT 1 FOR UPDATE;
  link_changed := employee_id IS NULL;

  IF employee_id IS NULL THEN
    SELECT id INTO employee_id FROM app.employees
    WHERE tenant_id=p_tenant
      AND employee_code=membership_row.employee_code
      AND state='ACTIVE'
      AND (
        membership_row.invited_email IS NULL OR
        (email IS NOT NULL AND lower(trim(email))=lower(trim(membership_row.invited_email)))
      )
      AND (
        membership_row.invited_mobile IS NULL OR
        (mobile IS NOT NULL AND regexp_replace(mobile,'[^0-9+]','','g')=
          regexp_replace(membership_row.invited_mobile,'[^0-9+]','','g'))
      )
    FOR UPDATE;
    IF employee_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM app.employees WHERE tenant_id=p_tenant AND id=employee_id
        AND linked_membership_id IS NOT NULL AND linked_membership_id<>p_membership
    ) THEN
      RAISE EXCEPTION 'employee code is linked to another membership';
    END IF;
    IF employee_id IS NULL AND EXISTS(
      SELECT 1 FROM app.employees
      WHERE tenant_id=p_tenant AND employee_code=membership_row.employee_code
    ) THEN
      RAISE EXCEPTION 'EMPLOYEE_LINK_CONFIRMATION_REQUIRED: employee code exists but destination or state is incompatible with membership';
    END IF;
  END IF;

  SELECT app.resolve_tenant_attributable_actor(
    p_tenant,
    ARRAY[
      p_actor,
      membership_row.user_id,
      nullif(current_setting('app.actor_user_id',true),'')::uuid
    ]
  ) INTO actor_id;

  IF employee_id IS NULL THEN
    SELECT count(*)::int,(array_agg(node.id ORDER BY node.active_from,node.id))[1]
    INTO root_count,root_id
    FROM app.organization_nodes node
    JOIN app.authorization_scope_nodes scope
      ON scope.tenant_id=node.tenant_id
     AND scope.id=node.authorization_scope_node_id
     AND scope.scope_type='LEGAL_ENTITY'
     AND scope.status='ACTIVE'
     AND scope.canonical_resource_id=node.id
    JOIN app.authorization_scope_nodes tenant_scope
      ON tenant_scope.tenant_id=scope.tenant_id
     AND tenant_scope.id=scope.parent_id
     AND tenant_scope.scope_type='TENANT'
     AND tenant_scope.status='ACTIVE'
    WHERE node.tenant_id=p_tenant AND node.node_type='LEGAL_ENTITY'
      AND node.parent_id IS NULL AND node.state='ACTIVE';
    IF root_count<>1 THEN
      RAISE EXCEPTION 'tenant must have exactly one active canonical default legal root';
    END IF;
    IF actor_id IS NULL THEN RAISE EXCEPTION 'employee creation actor is unavailable'; END IF;
    INSERT INTO app.employees(
      tenant_id,employee_code,display_name,email,mobile,home_node_id,
      linked_membership_id,active_from,created_by
    ) VALUES(
      p_tenant,membership_row.employee_code,membership_row.invited_name,
      membership_row.invited_email,membership_row.invited_mobile,root_id,
      p_membership,(now() AT TIME ZONE (SELECT timezone FROM app.tenants WHERE id=p_tenant))::date,
      actor_id
    ) RETURNING id INTO employee_id;
  ELSE
    IF EXISTS(
      SELECT 1 FROM app.employees
      WHERE tenant_id=p_tenant AND employee_code=membership_row.employee_code AND id<>employee_id
    ) THEN RAISE EXCEPTION 'employee code collision prevents membership linkage'; END IF;
    UPDATE app.employees SET
      employee_code=membership_row.employee_code,
      display_name=membership_row.invited_name,
      email=coalesce(membership_row.invited_email,email),
      mobile=coalesce(membership_row.invited_mobile,mobile),
      linked_membership_id=p_membership,
      updated_at=now(),version=version+1
    WHERE tenant_id=p_tenant AND id=employee_id AND (
      employee_code IS DISTINCT FROM membership_row.employee_code OR
      display_name IS DISTINCT FROM membership_row.invited_name OR
      (membership_row.invited_email IS NOT NULL AND email IS DISTINCT FROM membership_row.invited_email) OR
      (membership_row.invited_mobile IS NOT NULL AND mobile IS DISTINCT FROM membership_row.invited_mobile) OR
      linked_membership_id IS DISTINCT FROM p_membership
    );
  END IF;

  IF link_changed THEN
    IF actor_id IS NULL THEN RAISE EXCEPTION 'employee linkage actor is unavailable'; END IF;
    INSERT INTO audit.audit_events(
      tenant_id,actor_id,action,target_type,target_id,correlation_id,after_json
    ) VALUES(
      p_tenant,actor_id,'identity.employee.linked','employee',employee_id,
      coalesce(nullif(current_setting('app.correlation_id',true),''),'membership-employee-'||p_membership::text),
      jsonb_build_object('membershipId',p_membership,'portalAudience','INTERNAL')
    );
    INSERT INTO app.outbox_events(
      tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key
    ) VALUES(
      p_tenant,'TENANT','employee',employee_id,'identity.employee.linked.v1',
      jsonb_build_object('employeeId',employee_id,'membershipId',p_membership),
      'identity-employee-link:'||p_tenant::text||':'||p_membership::text||':v'||membership_row.version::text
    ) ON CONFLICT(deduplication_key) DO NOTHING;
  END IF;
  RETURN employee_id;
END $$;

DO $$
DECLARE
  membership_row record;
  migration_actor uuid;
BEGIN
  SELECT id INTO migration_actor
  FROM app.users
  WHERE is_platform_admin AND status='ACTIVE'
  ORDER BY created_at,id
  LIMIT 1;
  IF migration_actor IS NULL AND EXISTS(
    SELECT 1 FROM app.tenant_memberships WHERE portal_audience='INTERNAL'
  ) THEN
    RAISE EXCEPTION 'INTERNAL membership Employee backfill requires an active platform administrator migration actor';
  END IF;
  FOR membership_row IN
    SELECT tenant_id,id FROM app.tenant_memberships
    WHERE portal_audience='INTERNAL' ORDER BY tenant_id,created_at,id
  LOOP
    PERFORM app.ensure_internal_membership_employee(
      membership_row.tenant_id,membership_row.id,migration_actor
    );
  END LOOP;
END $$;

CREATE UNIQUE INDEX employees_one_linked_membership
  ON app.employees(tenant_id,linked_membership_id)
  WHERE linked_membership_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.validate_employee_membership_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE membership_row record;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.linked_membership_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM app.tenant_memberships membership
      WHERE membership.tenant_id=OLD.tenant_id
        AND membership.id=OLD.linked_membership_id
        AND membership.portal_audience='INTERNAL'
    ) THEN RAISE EXCEPTION 'an employee linked to an INTERNAL membership cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.linked_membership_id IS NOT NULL
     AND OLD.linked_membership_id IS DISTINCT FROM NEW.linked_membership_id
     AND EXISTS(
       SELECT 1 FROM app.tenant_memberships membership
       WHERE membership.tenant_id=OLD.tenant_id
         AND membership.id=OLD.linked_membership_id
         AND membership.portal_audience='INTERNAL'
     ) THEN
    RAISE EXCEPTION 'an INTERNAL membership employee link cannot be removed or reassigned directly';
  END IF;
  IF NEW.linked_membership_id IS NOT NULL THEN
    SELECT * INTO membership_row FROM app.tenant_memberships membership
    WHERE membership.tenant_id=NEW.tenant_id
      AND membership.id=NEW.linked_membership_id;
    IF NOT FOUND OR membership_row.portal_audience<>'INTERNAL' THEN
      RAISE EXCEPTION 'employees may link only to an INTERNAL membership in the same tenant';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employees_validate_internal_membership
BEFORE INSERT OR DELETE OR UPDATE OF tenant_id,linked_membership_id ON app.employees
FOR EACH ROW EXECUTE FUNCTION app.validate_employee_membership_link();

CREATE OR REPLACE FUNCTION app.assert_employee_membership_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE membership_row record;
BEGIN
  IF NEW.linked_membership_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO membership_row FROM app.tenant_memberships membership
  WHERE membership.tenant_id=NEW.tenant_id AND membership.id=NEW.linked_membership_id;
  IF NOT FOUND OR membership_row.portal_audience<>'INTERNAL' OR
     NEW.employee_code IS DISTINCT FROM membership_row.employee_code OR
     (membership_row.invited_email IS NOT NULL AND
       lower(trim(NEW.email)) IS DISTINCT FROM lower(trim(membership_row.invited_email))) OR
     (membership_row.invited_mobile IS NOT NULL AND
       regexp_replace(NEW.mobile,'[^0-9+]','','g') IS DISTINCT FROM
       regexp_replace(membership_row.invited_mobile,'[^0-9+]','','g')) THEN
    RAISE EXCEPTION 'linked employee and INTERNAL membership are inconsistent';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER employees_membership_consistency
AFTER INSERT OR UPDATE ON app.employees
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.assert_employee_membership_consistency();

CREATE OR REPLACE FUNCTION app.assert_internal_membership_employee()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked_count integer;
BEGIN
  IF NEW.portal_audience<>'INTERNAL' THEN RETURN NEW; END IF;
  SELECT count(*)::int INTO linked_count FROM app.employees employee
  WHERE employee.tenant_id=NEW.tenant_id AND employee.linked_membership_id=NEW.id;
  IF linked_count<>1 THEN
    RAISE EXCEPTION 'INTERNAL membership must have exactly one linked employee';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM app.employees employee
    WHERE employee.tenant_id=NEW.tenant_id AND employee.linked_membership_id=NEW.id
      AND employee.employee_code=NEW.employee_code
      AND (NEW.invited_email IS NULL OR
        lower(trim(employee.email))=lower(trim(NEW.invited_email)))
      AND (NEW.invited_mobile IS NULL OR
        regexp_replace(employee.mobile,'[^0-9+]','','g')=
        regexp_replace(NEW.invited_mobile,'[^0-9+]','','g'))
  ) THEN RAISE EXCEPTION 'INTERNAL membership and linked employee are inconsistent'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER internal_membership_employee_consistency
AFTER INSERT OR UPDATE ON app.tenant_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.assert_internal_membership_employee();

CREATE OR REPLACE FUNCTION app.sync_internal_membership_employee()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  employee_id uuid;
  actor_id uuid;
BEGIN
  IF NEW.portal_audience='INTERNAL' THEN
    PERFORM app.ensure_internal_membership_employee(
      NEW.tenant_id,NEW.id,coalesce(NEW.user_id,nullif(current_setting('app.actor_user_id',true),'')::uuid)
    );
  ELSIF TG_OP='UPDATE' AND OLD.portal_audience='INTERNAL' THEN
    UPDATE app.employees SET linked_membership_id=NULL,updated_at=now(),version=version+1
    WHERE tenant_id=NEW.tenant_id AND linked_membership_id=NEW.id
    RETURNING id INTO employee_id;
    IF employee_id IS NOT NULL THEN
      SELECT app.resolve_tenant_attributable_actor(
        NEW.tenant_id,
        ARRAY[
          NEW.user_id,
          OLD.user_id,
          nullif(current_setting('app.actor_user_id',true),'')::uuid
        ]
      ) INTO actor_id;
      IF actor_id IS NULL THEN RAISE EXCEPTION 'employee unlink actor is unavailable'; END IF;
      INSERT INTO audit.audit_events(
        tenant_id,actor_id,action,target_type,target_id,correlation_id,before_json,after_json
      ) VALUES(
        NEW.tenant_id,actor_id,'identity.employee.unlinked','employee',employee_id,
        coalesce(nullif(current_setting('app.correlation_id',true),''),'membership-employee-unlink-'||NEW.id::text),
        jsonb_build_object('membershipId',NEW.id,'portalAudience','INTERNAL'),
        jsonb_build_object('membershipId',NEW.id,'portalAudience',NEW.portal_audience)
      );
      INSERT INTO app.outbox_events(
        tenant_id,scope,aggregate_type,aggregate_id,event_type,payload,deduplication_key
      ) VALUES(
        NEW.tenant_id,'TENANT','employee',employee_id,'identity.employee.unlinked.v1',
        jsonb_build_object('employeeId',employee_id,'membershipId',NEW.id,'portalAudience',NEW.portal_audience),
        'identity-employee-unlink:'||NEW.tenant_id::text||':'||NEW.id::text||':v'||NEW.version::text
      ) ON CONFLICT(deduplication_key) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_memberships_sync_employee
AFTER INSERT OR UPDATE OF portal_audience,employee_code,invited_name,invited_email,invited_mobile,user_id
ON app.tenant_memberships
FOR EACH ROW EXECUTE FUNCTION app.sync_internal_membership_employee();

COMMIT;
