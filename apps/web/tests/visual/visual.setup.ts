import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test as setup } from "@playwright/test";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";
import { AUTH, FIXTURE } from "./fixture.ts";

/**
 * Put the world in a known state, then sign in as both account spaces.
 *
 * A setup *project* rather than globalSetup, because this needs the server
 * running and Playwright starts the web server around the test run, not around
 * globalSetup. The screenshot projects declare `dependencies: ["setup"]`, so
 * ordering is a fact of the config rather than something to remember.
 *
 * Signing in through the form, rather than writing a session row and setting
 * the cookie by hand, is the point of doing it here. Cookie names change with
 * NODE_ENV — `__Host-` prefixed in production, bare in development — and every
 * attribute of them is a security contract stated once in lib/auth/cookies.ts.
 * A test that restated it would be a second copy of that contract, wrong the
 * first time either half moved.
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

setup("seed the fixture", async () => {
  /*
   * A subprocess under tsx, not an import.
   *
   * The seed reaches into @whatsapp-os/core for argon2 and the encryption
   * keyring, which resolve to TypeScript source through a workspace symlink.
   * Playwright's loader does not transform anything it resolves inside
   * node_modules, so importing it here fails on the first `.ts` extension.
   * tsx does, and the repo already runs its other scripts that way.
   */
  /* execSync rather than execFileSync: on Windows `npm` is a .cmd, which Node
     24 refuses to spawn without a shell, and passing an argument array *with*
     a shell earns a deprecation warning on every run. A single command string
     through the shell is the one form that is quiet on both platforms. */
  execSync("npm run visual:seed", { cwd: webRoot, stdio: "inherit" });
});

setup("sign in as the tenant owner", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(FIXTURE.tenant.username);
  await page.getByLabel("Password").fill(FIXTURE.tenant.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL("**/dashboard");
  await page.context().storageState({ path: AUTH.tenant });
});

setup("sign in as the platform operator", async ({ page }) => {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Username").fill(FIXTURE.admin.username);
  await page.getByLabel("Password").fill(FIXTURE.admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL("**/admin");
  await page.context().storageState({ path: AUTH.admin });
});

setup("restore the timestamps signing in moved", async () => {
  /*
   * Sign-in stamps last_login_at, and the admin console renders the owner's on
   * both the company card and the company overview — as an absolute IST
   * timestamp, so it would differ on every run and two pages would diff every
   * time for a reason that has nothing to do with their layout.
   *
   * Putting it back afterwards keeps the sign-in real. The alternative — a
   * second user who never signs in — would mean the account the screenshots
   * describe is not the account the session belongs to, which is a subtler lie
   * than a moving timestamp.
   */
  const client = new pg.Client({ connectionString: testSuperuserDatabaseUrl() });
  await client.connect();

  try {
    const { rowCount } = await client.query(
      `UPDATE users SET last_login_at = $2 WHERE username = $1`,
      [FIXTURE.tenant.username, FIXTURE.ownerLastLoginAt],
    );

    /* Zero rows means the seed and the sign-in disagree about who the fixture
       is, which would otherwise show up as an unexplained pixel diff. */
    expect(rowCount, "the fixture owner was not found to restore").toBe(1);
  } finally {
    await client.end();
  }
});
