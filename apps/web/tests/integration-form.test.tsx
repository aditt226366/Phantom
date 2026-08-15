import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The other half of the echo check: what actually reaches the DOM.
 *
 * The action's state is asserted in tests/server/integration-form-echo.test.ts.
 * This asserts the form cannot put a secret into the markup even when handed
 * one — because "the state is clean" and "the page is clean" are two claims,
 * and a component that helpfully re-read a value from somewhere else would
 * satisfy the first while breaking the second.
 */

const TOKEN = "EAAGm0PX4ZCpsBO7ZBxRealLookingAccessToken99";

/** A state shaped like a bug: a secret smuggled into `values`. */
const LEAKY_STATE = {
  message: "Check the highlighted fields.",
  fieldErrors: { GOOGLE_SERVICE_ACCOUNT_EMAIL: "Enter a valid address" },
  values: {
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "not-an-email",
    GOOGLE_PRIVATE_KEY: TOKEN,
    GOOGLE_SHEETS_ID: "1A2B3C4D5E6F7G8H9I0J",
  },
};

/*
 * The action reaches server-only modules through the vault; a component test
 * has no business loading them, and jsdom cannot.
 */
vi.mock("@/app/(admin)/admin/actions", () => ({
  saveIntegrationAction: async () => LEAKY_STATE,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useActionState: () => [LEAKY_STATE, () => undefined, false],
  };
});

/**
 * Mutable so a test can put the form in flight.
 *
 * Save & Verify makes a real provider call with a ten-second timeout, and a
 * still page invites a second click — two provider calls, two charged usage
 * events, and an operator unsure which result they are reading.
 */
let formStatus: { pending: boolean; data?: FormData } = { pending: false };

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, useFormStatus: () => formStatus };
});

const { IntegrationForm } = await import(
  "@/app/(admin)/admin/_components/integration-form"
);

function pendingWith(intent: string): void {
  const data = new FormData();
  data.set("intent", intent);
  formStatus = { pending: true, data };
}

function renderForm() {
  return render(
    <IntegrationForm
      companyId="company-1"
      provider="GOOGLE_SHEETS"
      stored={[
        { key: "GOOGLE_PRIVATE_KEY", last4: "en99" },
        { key: "GOOGLE_SHEETS_ID", last4: null },
      ]}
      csrf={<input type="hidden" name="csrfToken" defaultValue="t" />}
    />,
  );
}

describe("while a submission is in flight", () => {
  afterEach(() => {
    formStatus = { pending: false };
  });

  it("disables both save buttons", () => {
    pendingWith("verify");
    renderForm();

    expect(
      (screen.getByRole("button", { name: /save$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /verifying/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("changes the label on the button that was pressed, not both", () => {
    pendingWith("verify");
    renderForm();

    expect(screen.getByRole("button", { name: "Verifying…" })).toBeDefined();
    /* Save keeps its own label, so the operator can see which one is running. */
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("does the same for a plain save", () => {
    pendingWith("save");
    renderForm();

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Save & Verify" })).toBeDefined();
  });

  it("leaves both enabled when idle", () => {
    renderForm();

    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Save & Verify" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("IntegrationForm", () => {
  it("puts no part of a secret into the markup", () => {
    const { container } = renderForm();
    const html = container.innerHTML;

    for (let start = 0; start + 12 <= TOKEN.length; start += 4) {
      const fragment = TOKEN.slice(start, start + 12);
      expect(html, `markup leaked "${fragment}"`).not.toContain(fragment);
    }
  });

  it("renders secret fields empty even when state carries a value", () => {
    renderForm();

    const privateKey = screen.getByLabelText("Private key") as HTMLInputElement;

    expect(privateKey.value).toBe("");
    expect(privateKey.type).toBe("password");
  });

  it("repopulates the non-secret field", () => {
    renderForm();

    const email = screen.getByLabelText(
      "Service account email",
    ) as HTMLInputElement;

    expect(email.value).toBe("not-an-email");
    expect(email.type).toBe("text");
  });

  it("shows a mask built from last4, not the value", () => {
    renderForm();

    const privateKey = screen.getByLabelText("Private key") as HTMLInputElement;

    expect(privateKey.placeholder).toBe("••••••••en99");
  });

  it("says stored without a hint when the value was too short for last4", () => {
    renderForm();

    const sheetId = screen.getByLabelText("Spreadsheet ID") as HTMLInputElement;

    expect(sheetId.placeholder).toBe("•••••••• (stored)");
  });

  it("says Not set for a credential that has never been saved", () => {
    render(
      <IntegrationForm
        companyId="company-1"
        provider="META_ADS"
        stored={[]}
        csrf={null}
      />,
    );

    const token = screen.getByLabelText("Access token") as HTMLInputElement;

    expect(token.placeholder).toBe("Not set");
  });

  it("tells the user blank keeps the stored value", () => {
    renderForm();

    expect(screen.getByText(/leave a field blank/i)).toBeDefined();
  });
});
