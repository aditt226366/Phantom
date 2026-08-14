import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_FIELD_NAME } from "@/lib/auth/cookies";
import type { SessionContext } from "@/lib/auth/session-store";

/**
 * `next/headers` only works inside a request, so cookies() is mocked. The logic
 * under test — the comparisons — is entirely ours; only the source of the
 * cookie is Next's.
 */

let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieValue === undefined ? undefined : { name, value: cookieValue },
  }),
}));

const { assertCsrf, CsrfError } = await import("@/lib/auth/csrf");

function formWith(token?: string): FormData {
  const data = new FormData();
  if (token !== undefined) data.set(CSRF_FIELD_NAME, token);
  return data;
}

const session: SessionContext = {
  sessionId: "s1",
  companyId: "c1",
  userId: "u1",
  csrfSecret: "the-session-secret",
  expiresAt: new Date(Date.now() + 60_000),
  user: {
    id: "u1",
    fullName: "Ada",
    email: "ada@example.test",
    username: "ada",
    phoneE164: "+919876543210",
    emailVerifiedAt: null,
    role: "OWNER",
  },
  company: { id: "c1", name: "Analytical Engines", slug: "analytical-engines" },
};

afterEach(() => {
  cookieValue = undefined;
});

describe("assertCsrf", () => {
  it("accepts a token matching the cookie", async () => {
    cookieValue = "a-valid-token";
    await expect(assertCsrf(formWith("a-valid-token"))).resolves.toBeUndefined();
  });

  it("rejects a mismatched token", async () => {
    cookieValue = "a-valid-token";
    await expect(assertCsrf(formWith("a-different-token"))).rejects.toThrow(
      CsrfError,
    );
  });

  it("rejects a missing form field", async () => {
    cookieValue = "a-valid-token";
    await expect(assertCsrf(formWith())).rejects.toThrow(/Missing CSRF token/);
  });

  it("rejects an empty form field", async () => {
    cookieValue = "a-valid-token";
    await expect(assertCsrf(formWith(""))).rejects.toThrow(/Missing CSRF token/);
  });

  it("rejects when the cookie is absent", async () => {
    cookieValue = undefined;
    await expect(assertCsrf(formWith("anything"))).rejects.toThrow(
      /Missing CSRF cookie/,
    );
  });

  it("binds an authenticated submission to the session row", async () => {
    /*
     * The case the cookie comparison alone cannot see. A sibling subdomain can
     * write the CSRF cookie, so an attacker can make cookie and form field
     * agree on a value of their choosing. It will not match the secret stored
     * on the session row.
     */
    cookieValue = "injected-by-a-subdomain";

    await expect(
      assertCsrf(formWith("injected-by-a-subdomain"), session),
    ).rejects.toThrow(/not bound to this session/);
  });

  it("accepts when cookie, field and session secret all agree", async () => {
    /* The normal case: startSession sets the cookie to the session's secret. */
    cookieValue = session.csrfSecret;

    await expect(
      assertCsrf(formWith(session.csrfSecret), session),
    ).resolves.toBeUndefined();
  });

  it("still checks the cookie for an authenticated submission", async () => {
    cookieValue = "something-else";

    await expect(
      assertCsrf(formWith(session.csrfSecret), session),
    ).rejects.toThrow(/does not match/);
  });
});
