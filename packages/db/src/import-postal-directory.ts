import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createDatabase } from "./index.js";

type ImportRow = {
  id: string;
  postalCode: string;
  localityCode: string;
  localityName: string;
  districtName: string;
  cityName: string;
  regionName: string;
};

const importDatabaseUrl = process.env.POSTAL_IMPORT_DATABASE_URL?.trim();
const runtimeDatabaseUrl = process.env.DATABASE_URL?.trim();
if (!importDatabaseUrl)
  throw new Error(
    "POSTAL_IMPORT_DATABASE_URL is required and must use logistics_postal_importer",
  );
if (!runtimeDatabaseUrl) throw new Error("DATABASE_URL is required");
const expectedDatabase = process.env.POSTAL_IMPORT_EXPECTED_DATABASE?.trim();
if (!expectedDatabase)
  throw new Error("POSTAL_IMPORT_EXPECTED_DATABASE is required");
const databaseTarget = (label: string, value: string) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol))
    throw new Error(`${label} must use the postgresql protocol`);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const username = decodeURIComponent(parsed.username);
  if (!parsed.hostname || !database || database.includes("/") || !username)
    throw new Error(`${label} must include one host, database, and username`);
  return {
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database,
    username,
  };
};
const runtimeTarget = databaseTarget("DATABASE_URL", runtimeDatabaseUrl);
const importTarget = databaseTarget(
  "POSTAL_IMPORT_DATABASE_URL",
  importDatabaseUrl,
);
if (
  runtimeTarget.hostname !== importTarget.hostname ||
  runtimeTarget.port !== importTarget.port ||
  runtimeTarget.database !== importTarget.database
)
  throw new Error(
    "Runtime and postal-import URLs must target the same host, port, and database",
  );
if (runtimeTarget.username === importTarget.username)
  throw new Error(
    "Postal import must use a username separate from the runtime",
  );
if (
  runtimeTarget.database !== expectedDatabase ||
  importTarget.database !== expectedDatabase
)
  throw new Error(
    `Both database URLs must target POSTAL_IMPORT_EXPECTED_DATABASE=${expectedDatabase}`,
  );

const args = new Map<string, string>();
const cliArguments = process.argv.slice(2).filter((value) => value !== "--");
for (let index = 0; index < cliArguments.length; index += 2) {
  const key = cliArguments[index];
  const value = cliArguments[index + 1];
  if (!key?.startsWith("--") || !value)
    throw new Error(`Invalid argument near ${key ?? "end of command"}`);
  args.set(key.slice(2), value);
}
const required = (key: string) => {
  const value = args.get(key)?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
};
const file = resolve(required("file"));
const version = required("version");
const expectedChecksum = required("sha256").toLowerCase();
const sourceName = required("source-name");
const sourceUri = required("source-uri");
const importedBy = required("imported-by");
const country = (args.get("country") ?? "IN").toUpperCase();
const activate = (args.get("activate") ?? "false") === "true";
const appEnvironment = process.env.APP_ENV ?? "local";
if (
  appEnvironment === "production" &&
  /(^|[-_])(test|dev|local)([-_]|$)/i.test(runtimeTarget.database)
)
  throw new Error(
    "Production postal imports cannot target a test/dev/local database",
  );
const minimumRows = Number(
  process.env.POSTAL_DIRECTORY_MIN_ROWS ??
    (appEnvironment === "production" ? "100000" : "1"),
);
if (!/^[A-Z]{2}$/.test(country))
  throw new Error("--country must be ISO alpha-2");
if (!/^[0-9a-f]{64}$/.test(expectedChecksum))
  throw new Error("--sha256 must be a lowercase or uppercase SHA-256 digest");
if (!Number.isSafeInteger(minimumRows) || minimumRows < 1)
  throw new Error("POSTAL_DIRECTORY_MIN_ROWS must be a positive integer");
if (!/^https?:\/\//.test(sourceUri))
  throw new Error(
    "--source-uri must identify the official HTTPS download page",
  );
if (
  appEnvironment === "production" &&
  /fixture|sample|demo|bootstrap/i.test(`${version} ${sourceName} ${file}`)
)
  throw new Error(
    "Fixture or sample postal datasets cannot be imported in production",
  );

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted value");
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

const bytes = await readFile(file);
const actualChecksum = createHash("sha256").update(bytes).digest("hex");
if (actualChecksum !== expectedChecksum)
  throw new Error(
    `Checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}`,
  );
const csv = parseCsv(bytes.toString("utf8").replace(/^\uFEFF/, ""));
const header = csv.shift();
if (!header) throw new Error("CSV is empty");
const normalizedHeaders = header.map((value) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, ""),
);
const column = (...names: string[]) => {
  const index = normalizedHeaders.findIndex((value) => names.includes(value));
  if (index < 0) throw new Error(`CSV is missing column ${names[0]}`);
  return index;
};
const postalColumn = column("pincode", "postalcode", "pin");
const localityColumn = column("officename", "localityname", "locality");
const districtColumn = column("districtname", "district");
const regionColumn = column("statename", "state", "regionname");
const cityColumn = normalizedHeaders.findIndex((value) =>
  ["cityname", "city", "taluk", "talukname"].includes(value),
);
const deduplicated = new Map<string, ImportRow>();
for (const [offset, values] of csv.entries()) {
  const postalCode = values[postalColumn]?.trim() ?? "";
  const localityName = values[localityColumn]?.trim() ?? "";
  const districtName = values[districtColumn]?.trim() ?? "";
  const regionName = values[regionColumn]?.trim() ?? "";
  const cityName =
    (cityColumn >= 0 ? values[cityColumn]?.trim() : "") || districtName;
  if (!/^[1-9][0-9]{5}$/.test(postalCode))
    throw new Error(`CSV row ${offset + 2} has an invalid PIN code`);
  if (![localityName, districtName, cityName, regionName].every(Boolean))
    throw new Error(`CSV row ${offset + 2} is missing canonical locality data`);
  const identity = [
    postalCode,
    localityName,
    districtName,
    cityName,
    regionName,
  ]
    .map((value) => value.toLocaleLowerCase("en-IN"))
    .join("|");
  if (!deduplicated.has(identity))
    deduplicated.set(identity, {
      id: randomUUID(),
      postalCode,
      localityCode: createHash("sha256")
        .update(identity)
        .digest("hex")
        .slice(0, 24),
      localityName,
      districtName,
      cityName,
      regionName,
    });
}
const rows = [...deduplicated.values()];
if (rows.length < minimumRows)
  throw new Error(
    `Dataset contains ${rows.length} canonical rows; minimum is ${minimumRows}`,
  );

const db = createDatabase(importDatabaseUrl);
const versionId = randomUUID();
try {
  const result = await db.$transaction(async (tx) => {
    const identities = await tx.$queryRawUnsafe<
      Array<{ sessionUser: string; currentUser: string; database: string }>
    >(
      `SELECT session_user AS "sessionUser",current_user AS "currentUser",current_database() AS database`,
    );
    if (
      identities[0]?.sessionUser !== "logistics_postal_importer" ||
      identities[0]?.currentUser !== "logistics_postal_importer"
    )
      throw new Error(
        "Postal import connection must authenticate as logistics_postal_importer",
      );
    if (identities[0]?.database !== expectedDatabase)
      throw new Error(
        `Postal import connected to ${identities[0]?.database ?? "an unknown database"}; expected ${expectedDatabase}`,
      );
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      `postal-directory:${country}`,
    );
    const existing = await tx.$queryRawUnsafe<
      Array<{ id: string; checksum: string; status: string; rowCount: number }>
    >(
      `SELECT id,checksum_sha256 AS checksum,status,row_count AS "rowCount"
       FROM postal_reference.postal_directory_versions WHERE country=$1 AND version=$2`,
      country,
      version,
    );
    if (existing[0]) {
      if (
        existing[0].checksum !== actualChecksum ||
        Number(existing[0].rowCount) !== rows.length
      )
        throw new Error(
          `Postal version conflict for ${country}/${version}; use a new version for changed content`,
        );
      if (activate && existing[0].status === "STAGED") {
        await tx.$executeRawUnsafe(
          `UPDATE postal_reference.postal_directory_versions SET active=false,status='RETIRED'
           WHERE country=$1 AND status='ACTIVE'`,
          country,
        );
        await tx.$executeRawUnsafe(
          `UPDATE postal_reference.postal_directory_versions
           SET active=true,status='ACTIVE',activated_at=now(),activated_by=$2
           WHERE id=$1::uuid AND status='STAGED'`,
          existing[0].id,
          importedBy,
        );
        return { versionId: existing[0].id, status: "ACTIVE", replayed: true };
      }
      return {
        versionId: existing[0].id,
        status: existing[0].status,
        replayed: true,
      };
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO postal_reference.postal_directory_versions
       (id,country,version,source_name,source_uri,source_filename,checksum_sha256,active,status,row_count,imported_by,imported_at)
       VALUES($1::uuid,$2,$3,$4,$5,$6,$7,false,'STAGED',$8,$9,now())`,
      versionId,
      country,
      version,
      sourceName,
      sourceUri,
      basename(file),
      actualChecksum,
      rows.length,
      importedBy,
    );
    for (let index = 0; index < rows.length; index += 1000) {
      const chunk = rows.slice(index, index + 1000);
      await tx.$executeRawUnsafe(
        `INSERT INTO postal_reference.postal_localities
         (id,directory_version_id,country,postal_code,locality_code,locality_name,district_name,city_name,region_name,active)
         SELECT x.id::uuid,$1::uuid,$2,x."postalCode",x."localityCode",x."localityName",x."districtName",x."cityName",x."regionName",true
         FROM jsonb_to_recordset($3::jsonb) AS x(id text,"postalCode" text,"localityCode" text,"localityName" text,"districtName" text,"cityName" text,"regionName" text)`,
        versionId,
        country,
        JSON.stringify(chunk),
      );
    }
    if (activate) {
      await tx.$executeRawUnsafe(
        `UPDATE postal_reference.postal_directory_versions SET active=false,status='RETIRED'
         WHERE country=$1 AND status='ACTIVE'`,
        country,
      );
      await tx.$executeRawUnsafe(
        `UPDATE postal_reference.postal_directory_versions
         SET active=true,status='ACTIVE',activated_at=now(),activated_by=$2
         WHERE id=$1::uuid AND status='STAGED'`,
        versionId,
        importedBy,
      );
    }
    return {
      versionId,
      status: activate ? "ACTIVE" : "STAGED",
      replayed: false,
    };
  });
  process.stdout.write(
    JSON.stringify({
      versionId: result.versionId,
      country,
      version,
      rowCount: rows.length,
      checksumSha256: actualChecksum,
      status: result.status,
      replayed: result.replayed,
    }) + "\n",
  );
} finally {
  await db.$disconnect();
}
