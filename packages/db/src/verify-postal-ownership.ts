import { createDatabase } from "./index.js";

const db = createDatabase();
try {
  const identity = await db.$queryRawUnsafe<
    Array<{ sessionUser: string; database: string }>
  >(`SELECT session_user AS "sessionUser",current_database() AS database`);
  const objects = await db.$queryRawUnsafe<
    Array<{ kind: string; name: string; owner: string; enabled: string | null }>
  >(`
    SELECT 'schema' kind,n.nspname name,r.rolname owner,NULL::text enabled
    FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='postal_reference'
    UNION ALL
    SELECT 'table',c.relname,r.rolname,NULL::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='postal_reference' AND c.relname IN ('postal_directory_versions','postal_localities')
    UNION ALL
    SELECT 'function',p.proname,r.rolname,NULL::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='postal_reference' AND p.proname='guard_postal_directory_mutation'
    UNION ALL
    SELECT 'trigger',t.tgname,r.rolname,t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='postal_reference' AND NOT t.tgisinternal AND t.tgname IN ('postal_directory_versions_import_only','postal_localities_import_only')
    ORDER BY kind,name`);
  const required = new Set([
    "schema:postal_reference",
    "table:postal_directory_versions",
    "table:postal_localities",
    "function:guard_postal_directory_mutation",
    "trigger:postal_directory_versions_import_only",
    "trigger:postal_localities_import_only",
  ]);
  for (const object of objects) {
    required.delete(`${object.kind}:${object.name}`);
    if (object.owner !== "logistics_postal_owner")
      throw new Error(
        `${object.kind} ${object.name} has unsafe owner ${object.owner}`,
      );
    if (object.kind === "trigger" && object.enabled !== "O")
      throw new Error(`trigger ${object.name} is not enabled`);
  }
  if (required.size)
    throw new Error(
      `Postal ownership handoff is incomplete: ${[...required].join(", ")}`,
    );
  if (identity[0]?.sessionUser === "logistics_postal_owner")
    throw new Error(
      "Runtime database session must not use postal owner identity",
    );
  process.stdout.write(
    `Postal ownership verified in ${identity[0]?.database} for runtime ${identity[0]?.sessionUser}.\n`,
  );
} finally {
  await db.$disconnect();
}
