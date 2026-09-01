import { pathToFileURL } from "node:url";
import { seedDemoProfile } from "./demo-seed.js";
import { jurigariSeedConfig } from "./jurigari-demo-config.js";
import { jurigariBootstrapProfile } from "./jurigari-demo-profile.js";

export async function seedJurigariDemo(
  env: NodeJS.ProcessEnv = process.env,
  databaseUrl?: string,
) {
  const config = jurigariSeedConfig(env);
  return seedDemoProfile(jurigariBootstrapProfile(config), config, databaseUrl);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await seedJurigariDemo();
}
