import argon2 from "argon2";
import { createDatabase, withPlatform } from "./index.js";

const email = (process.env.PLATFORM_ADMIN_EMAIL ?? "admin@local.test")
  .trim()
  .toLowerCase();
const password = process.env.PLATFORM_ADMIN_PASSWORD ?? "LocalAdmin!234";
if (password.length < 12)
  throw new Error("PLATFORM_ADMIN_PASSWORD must be at least 12 characters");
const db = createDatabase();
try {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await withPlatform(db, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO app.users (email, display_name, password_hash, is_platform_admin)
      VALUES (${email}, 'Local Platform Admin', ${passwordHash}, true)
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_platform_admin = true, updated_at = now(), version = app.users.version + 1
    `;
  });
  console.log(`Seeded platform administrator ${email}`);
} finally {
  await db.$disconnect();
}
