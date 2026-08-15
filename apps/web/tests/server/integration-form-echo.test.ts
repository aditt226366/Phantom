import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failed save must not hand the token back to the browser.
 *
 * This is the leak path that arrives by writing the obvious code: a save fails
 * validation, the form should keep what the user typed, so the action returns
 * the submission in its state — and React serialises that state into the HTML
 * of the response. The credential then sits in the page source, the
 * back-forward cache, and anything that logs response bodies, for a value the
 * rest of this panel never displays at all.
 *
 * Asserted against the action's real return value, with a token shaped like a
 * real one, checking for any substring of it rather than for the whole string.
 */

const TOKEN = "EAAGm0PX4ZCpsBO7ZBxRealLookingAccessToken99";
const SERVICE_ACCOUNT = "sheets@project-id.iam.gserviceaccount.com";

vi.mock("@/lib/auth/admin-session", () => ({
  requireAdminSession: async () => ({
    sessionId: "session",
    adminUserId: "admin",
    username: "operator",
    csrfSecret: "csrf",
  }),
  assertAdminCsrf: async () => undefined,
}));

vi.mock("@/lib/auth/request", () => ({
  requestContext: async () => ({ ip: undefined, userAgent: undefined }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

/* The save must never be reached; an invalid submission stops first. */
const saveIntegrationSecrets = vi.fn();

vi.mock("@/lib/admin-db", () => ({
  saveIntegrationSecrets,
  disconnectIntegration: vi.fn(),
  writeAdminAudit: vi.fn(),
}));

const { saveIntegrationAction } = await import(
  "@/app/(admin)/admin/actions"
);

/** An invalid save: a malformed service-account email, with real credentials typed. */
function invalidSubmission(): FormData {
  const form = new FormData();
  form.set("companyId", "company-1");
  form.set("provider", "GOOGLE_SHEETS");
  form.set("GOOGLE_SHEETS_ID", "1A2B3C4D5E6F7G8H9I0J");
  form.set("GOOGLE_SERVICE_ACCOUNT_EMAIL", "not-an-email");
  form.set("GOOGLE_PRIVATE_KEY", TOKEN);
  return form;
}

/** Every substring of the token long enough to be worth having. */
function substringsOf(secret: string, length = 12): string[] {
  const parts: string[] = [];
  for (let start = 0; start + length <= secret.length; start += 4) {
    parts.push(secret.slice(start, start + length));
  }
  return parts;
}

beforeEach(() => {
  saveIntegrationSecrets.mockReset();
});

describe("a failed credential save", () => {
  it("does not reach the vault", async () => {
    await saveIntegrationAction({}, invalidSubmission());

    expect(saveIntegrationSecrets).not.toHaveBeenCalled();
  });

  it("reports the field that was wrong", async () => {
    const state = await saveIntegrationAction({}, invalidSubmission());

    expect(state.fieldErrors?.["GOOGLE_SERVICE_ACCOUNT_EMAIL"]).toMatch(
      /service account/i,
    );
  });

  it("returns no substring of a secret value", async () => {
    const state = await saveIntegrationAction({}, invalidSubmission());
    const serialised = JSON.stringify(state);

    for (const fragment of substringsOf(TOKEN)) {
      expect(serialised, `state leaked "${fragment}"`).not.toContain(fragment);
    }
  });

  it("returns no substring of the other secret field either", async () => {
    /* GOOGLE_SHEETS_ID is secret: true — a spreadsheet id names a customer's
       document, and only the three declared identifiers come back. */
    const state = await saveIntegrationAction({}, invalidSubmission());

    expect(JSON.stringify(state)).not.toContain("1A2B3C4D5E6F7G8H9I0J");
  });

  it("does repopulate the non-secret field", async () => {
    /*
     * The other half. If nothing came back the flag would be pointless and the
     * safe implementation would be "return nothing", which is worse UX than it
     * needs to be — so assert the intended behaviour, not just the absence of
     * the bad one.
     */
    const form = invalidSubmission();
    form.set("GOOGLE_SERVICE_ACCOUNT_EMAIL", "still-not-an-email");

    const state = await saveIntegrationAction({}, form);

    expect(state.values?.["GOOGLE_SERVICE_ACCOUNT_EMAIL"]).toBe(
      "still-not-an-email",
    );
    expect(Object.keys(state.values ?? {})).toEqual([
      "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    ]);
  });

  it("tells the user secret values must be re-entered", async () => {
    const state = await saveIntegrationAction({}, invalidSubmission());

    expect(`${state.message ?? ""}`).toMatch(/re-enter|blank/i);
  });

  it("rejects an entirely blank submission rather than pretending it saved", async () => {
    const form = new FormData();
    form.set("companyId", "company-1");
    form.set("provider", "GOOGLE_SHEETS");
    form.set("GOOGLE_SHEETS_ID", "");
    form.set("GOOGLE_SERVICE_ACCOUNT_EMAIL", SERVICE_ACCOUNT);
    form.set("GOOGLE_PRIVATE_KEY", "");

    /* One field filled is a legitimate save. */
    saveIntegrationSecrets.mockResolvedValue({
      integrationId: "i1",
      saved: ["GOOGLE_SERVICE_ACCOUNT_EMAIL"],
      unchanged: [],
    });
    const ok = await saveIntegrationAction({}, form);
    expect(ok.success).toBeDefined();

    form.set("GOOGLE_SERVICE_ACCOUNT_EMAIL", "");
    const empty = await saveIntegrationAction({}, form);
    expect(empty.message).toMatch(/at least one/i);
  });
});
