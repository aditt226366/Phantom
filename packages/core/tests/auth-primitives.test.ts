import { describe, expect, it, vi } from "vitest";
import { signInSchema, signUpSchema, usernameSchema } from "../src/auth-schemas.ts";
import { denylistSize, isCommonPassword } from "../src/denylist.ts";
import { createConsoleMailer, sendMailSafely } from "../src/mail.ts";
import { parsePhone } from "../src/phone.ts";
import {
  generateCsrfSecret,
  generateToken,
  hashToken,
  issueSessionToken,
  issueVerificationToken,
  tokensMatch,
} from "../src/tokens.ts";

describe("common-password denylist", () => {
  it("actually loaded", () => {
    /* An empty or missing file would make every check below vacuously pass. */
    expect(denylistSize()).toBeGreaterThan(9_000);
  });

  it("catches the obvious ones", () => {
    for (const password of ["password", "123456", "qwerty", "letmein"]) {
      expect(isCommonPassword(password), password).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    /* The list is not case-varied; matching case-sensitively would let the
       single most obvious evasion straight through. */
    expect(isCommonPassword("PASSWORD")).toBe(true);
    expect(isCommonPassword("PaSsWoRd")).toBe(true);
  });

  it("passes an uncommon password", () => {
    expect(isCommonPassword("chartreuse-hexagon-marmalade")).toBe(false);
  });

  it("runs without any network access", () => {
    /* The reason it exists: it is the check that still works when HIBP is
       unreachable, so it must not itself depend on the network. */
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(isCommonPassword("password")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe("phone parsing", () => {
  it("accepts an Indian number without a country code", () => {
    const result = parsePhone("9876543210");
    expect(result).toEqual({ ok: true, e164: "+919876543210" });
  });

  it("normalises formatting to one canonical form", () => {
    const forms = ["+91 98765 43210", "098765 43210", "+91-98765-43210"];

    for (const form of forms) {
      expect(parsePhone(form), form).toEqual({
        ok: true,
        e164: "+919876543210",
      });
    }
  });

  it("honours an explicit country code over the default region", () => {
    const result = parsePhone("+442071838750");
    expect(result).toEqual({ ok: true, e164: "+442071838750" });
  });

  it("rejects invalid numbers", () => {
    for (const bad of ["", "   ", "12345", "not a number", "+91 1"]) {
      expect(parsePhone(bad).ok, bad).toBe(false);
    }
  });
});

describe("username schema", () => {
  it("lowercases before validating", () => {
    /* Order matters: validate first and "Alice" is rejected as containing
       invalid characters rather than accepted as "alice". */
    expect(usernameSchema.parse("Alice")).toBe("alice");
    expect(usernameSchema.parse("  MiXeD.Case_1  ")).toBe("mixed.case_1");
  });

  it("enforces the boundaries at 3 and 32", () => {
    expect(usernameSchema.safeParse("ab").success).toBe(false);
    expect(usernameSchema.safeParse("abc").success).toBe(true);
    expect(usernameSchema.safeParse("a".repeat(32)).success).toBe(true);
    expect(usernameSchema.safeParse("a".repeat(33)).success).toBe(false);
  });

  it("allows only letters, digits, dots and underscores", () => {
    expect(usernameSchema.safeParse("good_name.1").success).toBe(true);

    for (const bad of ["has space", "has-hyphen", "has@at", "has/slash", "héllo", "🙂🙂🙂"]) {
      expect(usernameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("sign-up schema", () => {
  const valid = {
    fullName: "Ada Lovelace",
    companyName: "Analytical Engines",
    email: "Ada@Example.COM",
    phone: "9876543210",
    username: "Ada_L",
    password: "a-sufficiently-long-password",
    confirmPassword: "a-sufficiently-long-password",
  };

  it("accepts a complete form and normalises it", () => {
    const parsed = signUpSchema.parse(valid);
    expect(parsed.email).toBe("ada@example.com");
    expect(parsed.username).toBe("ada_l");
  });

  it("reports mismatched passwords against confirmPassword", () => {
    const result = signUpSchema.safeParse({
      ...valid,
      confirmPassword: "something-else-entirely",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      /* The field the user has to retype, not the one they typed first. */
      expect(result.error.issues[0]?.path).toEqual(["confirmPassword"]);
    }
  });

  it("requires at least 12 characters", () => {
    const short = "abc123456789".slice(0, 11);
    const result = signUpSchema.safeParse({
      ...valid,
      password: short,
      confirmPassword: short,
    });

    expect(result.success).toBe(false);
  });
});

describe("sign-in schema", () => {
  it("does not validate the username format", () => {
    /*
     * Deliberate. Telling the user "that is not a valid username" separates a
     * malformed guess from a well-formed one that does not exist, which is the
     * account enumeration the whole flow is built to avoid.
     */
    const result = signInSchema.safeParse({
      username: "not a valid username!",
      password: "whatever",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.username).toBe("not a valid username!");
    }
  });

  it("lowercases the username", () => {
    const parsed = signInSchema.parse({ username: "ADA_L", password: "x" });
    expect(parsed.username).toBe("ada_l");
  });
});

describe("tokens", () => {
  it("produces distinct values", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(tokens.size).toBe(100);
  });

  it("is URL-safe", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("never stores the raw token", () => {
    /*
     * The rule the module exists for: a database dump must not contain a usable
     * credential. tokenHash is what gets persisted, and it is not the token.
     */
    const issued = issueSessionToken();

    expect(issued.tokenHash).not.toBe(issued.token);
    expect(issued.tokenHash).toBe(hashToken(issued.token));
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.tokenHash).not.toContain(issued.token);
  });

  it("hashes deterministically so a presented token can be looked up", () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateToken()));
  });

  it("expires sessions in 30 days and verification links in 24 hours", () => {
    const now = Date.now();

    const session = issueSessionToken();
    const sessionDays = (session.expiresAt.getTime() - now) / 86_400_000;
    expect(sessionDays).toBeGreaterThan(29.9);
    expect(sessionDays).toBeLessThan(30.1);

    const verification = issueVerificationToken();
    const verificationHours =
      (verification.expiresAt.getTime() - now) / 3_600_000;
    expect(verificationHours).toBeGreaterThan(23.9);
    expect(verificationHours).toBeLessThan(24.1);
  });

  it("gives every session a distinct CSRF secret", () => {
    const secrets = new Set(
      Array.from({ length: 50 }, () => generateCsrfSecret()),
    );
    expect(secrets.size).toBe(50);
  });

  it("compares tokens without short-circuiting", () => {
    const token = generateToken();
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch(token, generateToken())).toBe(false);
    expect(tokensMatch(token, token.slice(0, -1))).toBe(false);
    expect(tokensMatch("", "")).toBe(true);
  });
});

describe("mail", () => {
  it("logs the message rather than sending it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await createConsoleMailer().sendMail({
      to: "ada@example.com",
      subject: "Verify your email",
      text: "https://example.com/verify?token=abc",
    });

    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[0]).toContain(
      "https://example.com/verify?token=abc",
    );

    info.mockRestore();
  });

  it("swallows a send failure instead of propagating it", async () => {
    /*
     * By the time mail is sent, the signup transaction has committed. Letting a
     * mail error escape would show a failure page for an account that exists —
     * and the user would then be told their email is already taken.
     */
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const broken = {
      sendMail: async () => {
        throw new Error("SMTP is on fire");
      },
    };

    await expect(
      sendMailSafely(broken, { to: "a@b.test", subject: "s", text: "t" }),
    ).resolves.toBe(false);
    expect(error).toHaveBeenCalled();

    error.mockRestore();
  });
});
