import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 moved the datasource URL out of schema.prisma and into this file.
 *
 * The .env path is resolved relative to THIS FILE rather than relying on
 * `dotenv/config`, which loads from process.cwd(). The Prisma CLI runs with
 * cwd = packages/db, so the bare import would look for packages/db/.env and
 * silently find nothing - leaving DATABASE_URL undefined and failing with
 * "datasource.url property is required".
 */
const here = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.resolve(here, "..", "..", ".env"), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
