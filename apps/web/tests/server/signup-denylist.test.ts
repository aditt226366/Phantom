import { signUpSchema } from "@whatsapp-os/core";
import { denylistSize, isCommonPassword } from "@whatsapp-os/core";
import { COMMON_PASSWORDS } from "../../../../packages/core/src/data/common-passwords.ts";
import pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signUp } from "@/lib/auth/signup";
import { testSuperuserDatabaseUrl } from "../../../../packages/db/scripts/db-urls.mjs";

/**
 * Sign-up, through the denylist, from the web project.
 *
 * ---------------------------------------------------------------------------
 * The gap this closes
 * ---------------------------------------------------------------------------
 *
 * The denylist had thorough unit tests in packages/core and no test that
 * reached it from a page. It loaded its data by resolving a path relative to
 * import.meta.url, which is correct Node and correct under Vitest, and broke
 * under Turbopack — so the whole suite stayed green while sign-up threw for
 * every user.
 *
 * A test in this project cannot reproduce a bundler difference; Vitest is not
 * Turbopack. What it does is make the path exercised rather than merely
 * exported, so a change that breaks loading fails here rather than in
 * somebody's browser. The bundler half is covered by the build, which now
 * collects page data for every route without throwing.
 */

const COMMON = "password";
const STRONG = "a-sufficiently-long-password";

async function superuser<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testSuperuserDatabaseUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function form(overrides: Record<string, string> = {}) {
  return signUpSchema.parse({
    fullName: "Ada Lovelace",
    companyName: "Analytical Engines",
    email: "ada@example.test",
    phone: "9876543210",
    username: "ada_l",
    password: STRONG,
    confirmPassword: STRONG,
    ...overrides,
  });
}

beforeEach(async () => {
  await superuser((client) =>
    client.query(
      `TRUNCATE TABLE "sessions", "email_verification_tokens", "audit_log",
                      "login_attempts", "users", "companies"
       RESTART IDENTITY CASCADE`,
    ),
  );

  /* HIBP stubbed: this is about the local list, not the network check. */
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("0".repeat(35) + ":1\n", { status: 200 })),
  );
});

describe("the denylist is actually loaded", () => {
  it("has entries", () => {
    /*
     * An empty list would make every assertion below pass for the wrong
     * reason — nothing is common, so nothing is rejected.
     */
    expect(denylistSize()).toBeGreaterThan(9000);
  });

  it("recognises a common password", () => {
    expect(isCommonPassword(COMMON)).toBe(true);
  });
});

describe("signUp", () => {
  it("rejects a common password", async () => {
    /*
     * The password minimum is 12 characters, so this is rejected for length
     * before the denylist would see it — which is exactly the honest coverage
     * note in denylist.ts. Passing the schema check is therefore not the
     * point; reaching signUp with a value the list knows is.
     */
    const result = await signUp(
      { ...form(), password: COMMON, confirmPassword: COMMON },
      {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("password_common");
  });

  it("rejects a long password that is still on the list", async () => {
    /*
     * One of the ten entries long enough to survive the length rule, which is
     * the only part of the list that does any work in practice. Picked from
     * the list itself rather than guessed, so it cannot rot.
     */
    const long = COMMON_PASSWORDS.find((entry) => entry.length >= 12);

    /* If the list ever loses its long entries this assertion is vacuous, so
       say so rather than passing quietly. */
    expect(long, "no denylist entry survives the 12-character minimum").toBeDefined();
    if (!long) return;

    const result = await signUp(
      { ...form(), password: long, confirmPassword: long },
      {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("password_common");
  });

  it("accepts a strong password and creates the account", async () => {
    const result = await signUp(form(), {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.companyId).toBeTruthy();
    expect(result.value.sessionToken).toBeTruthy();

    const rows = await superuser(async (client) => {
      const { rows } = await client.query<{ username: string }>(
        `SELECT username FROM users`,
      );
      return rows;
    });

    expect(rows.map((row) => row.username)).toEqual(["ada_l"]);
  });

  it("issues a verification token for the new account", async () => {
    /* What the dev terminal prints as a link. */
    await signUp(form(), {});

    const rows = await superuser(async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM email_verification_tokens`,
      );
      return rows;
    });

    expect(rows).toHaveLength(1);
  });
});
