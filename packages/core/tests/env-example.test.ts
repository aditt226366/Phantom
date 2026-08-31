import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import {
  safeParseEnv,
  sharedEnvSchema,
  webEnvSchema,
  workerEnvSchema,
} from "../src/env.ts";

/**
 * .env.example must actually boot the applications.
 *
 * This is the assertion that was missing when the encryption keyring landed.
 * Adding two required variables to the environment contract broke `npm run dev`
 * and `npm run build` outright — the app exits 1 at startup with "Invalid web
 * environment" — while all 329 tests stayed green, because nothing under test
 * parses webEnvSchema. Green suite, dead server, no signal anywhere between
 * them.
 *
 * .env is gitignored, so CI can never check the file a developer actually runs
 * with. .env.example is the committed contract, it is what `cp .env.example
 * .env` produces on a fresh clone, and it is what docker-compose substitutes
 * from. If a variable is missing or implausible there, the next person to clone
 * this repository cannot start it.
 *
 * Parsed with dotenv rather than read as text, so quoting rules — including the
 * single-quoting that stops Compose expanding `$` in an Argon2 hash — are
 * exercised the same way the real loader exercises them.
 */

/* cwd is the repo root under Vitest regardless of a project's `root`. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const examplePath = join(repoRoot, ".env.example");

const example = dotenv.parse(readFileSync(examplePath));

const SCHEMAS = [
  ["shared", sharedEnvSchema],
  ["web", webEnvSchema],
  ["worker", workerEnvSchema],
] as const;

describe(".env.example", () => {
  it("is not empty", () => {
    /* A path that resolved to the wrong place would make every check below
       vacuous in the most convincing way possible: silently. */
    expect(Object.keys(example).length).toBeGreaterThan(5);
  });

  for (const [name, schema] of SCHEMAS) {
    it(`satisfies the ${name} environment contract`, () => {
      const result = safeParseEnv(schema, example, `${name} environment`);

      expect(
        result.ok ? "" : result.error,
        `.env.example does not satisfy ${name}EnvSchema — a fresh clone cannot boot`,
      ).toBe("");
    });
  }

  it("documents every variable the contract requires", () => {
    /*
     * The reverse direction. A variable with a default parses happily when
     * absent, so the check above would pass while .env.example silently stopped
     * mentioning it — and .env.example is also the documentation.
     */
    const declared = new Set(Object.keys(example));
    const contract = Object.keys(workerEnvSchema.shape).concat(
      Object.keys(webEnvSchema.shape),
    );

    const undocumented = contract
      .filter((name) => !declared.has(name))
      /* Optional by design: the app boots without an admin panel. */
      .filter((name) => name !== "DATABASE_URL_ADMIN")
      /* Set by the platform, not by a developer's .env. */
      .filter((name) => name !== "NODE_ENV")
      /*
       * Deliberately undocumented, and this is the one exclusion that is a
       * decision rather than an accommodation.
       *
       * .env.example is what `cp .env.example .env` produces on a fresh clone,
       * so listing LEAD_SHEET_FIXTURE there would put the screenshot suite's
       * fixture flag into every developer's environment - which is the exact
       * inheritance the production guard in webEnvSchema exists to stop, handed
       * out by the documentation. It is set by playwright.config.ts and must be
       * set nowhere else.
       */
      .filter((name) => name !== "LEAD_SHEET_FIXTURE");

    expect(undocumented.sort()).toEqual([]);
  });
});
