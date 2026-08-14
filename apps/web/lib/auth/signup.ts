import "server-only";
import {
  checkPasswordBreached,
  hashPassword,
  isCommonPassword,
  issueVerificationToken,
  parsePhone,
  type SignUpInput,
} from "@whatsapp-os/core";
import {
  AuditAction,
  createCompany,
  newCompanyId,
  Prisma,
  resolveCompany,
  withCompany,
} from "@whatsapp-os/db";
import { auditWithin } from "./audit.ts";
import { createSessionRow } from "./session-store.ts";

/**
 * Create a company and its owner.
 *
 * ---------------------------------------------------------------------------
 * Shape of the operation, and why it is this shape
 * ---------------------------------------------------------------------------
 *
 *   validate -> denylist -> HIBP -> argon2      (slow, outside any transaction)
 *   -> companyId = newCompanyId()
 *   -> withCompany(companyId, ...)              (one transaction, all database)
 *   -> mail                                     (after commit, cannot roll back)
 *
 * The password work and the network call are outside the transaction because an
 * interactive transaction holds a pooled connection and Prisma times it out
 * after five seconds. A HIBP call at three seconds plus a ~100ms Argon2 hash
 * inside the transaction would spend most of that budget doing nothing with the
 * database, and exhaust the pool under any load at all.
 *
 * There is exactly one withCompany, and the session is created inside it. Using
 * a second transaction for the session would allow a failure between them that
 * leaves an account nobody is signed in to.
 *
 * The company id is generated before the transaction because the RLS policy on
 * companies only permits inserting a row whose id equals the current context —
 * see the row-level-security migration.
 */

export type SignUpFailure =
  | { reason: "password_common" }
  | { reason: "password_breached" }
  | { reason: "phone_invalid"; message: string }
  | { reason: "username_taken" }
  | { reason: "email_taken" };

export interface SignUpSuccess {
  companyId: string;
  userId: string;
  sessionToken: string;
  csrfSecret: string;
  verificationToken: string;
  /** True when HIBP could not be reached and the check was skipped. */
  breachCheckSkipped: boolean;
}

export type SignUpResult =
  | { ok: true; value: SignUpSuccess }
  | { ok: false; error: SignUpFailure };

export interface SignUpContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/** A slug collision needs the whole transaction retried, not just the insert. */
const SLUG_RETRIES = 3;

/**
 * Prisma reports a unique violation with no indication of which constraint.
 *
 * Running through a driver adapter, the message is literally "Unique constraint
 * failed on the (not available)" and `meta.target` is absent — so username,
 * email and slug conflicts are indistinguishable from the error object. Which
 * field to blame has to be established by asking, not by parsing.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * Which of the globally-unique fields is already taken, if either.
 *
 * Uses the resolver rather than a query, because both columns are unique across
 * the whole installation and no company context exists yet. It returns a
 * company id and nothing else, so this learns that the value is in use without
 * being able to see whose it is.
 */
async function findConflict(
  username: string,
  email: string,
): Promise<SignUpFailure | null> {
  const [usernameOwner, emailOwner] = await Promise.all([
    resolveCompany("username", username),
    resolveCompany("email", email),
  ]);

  if (usernameOwner) return { reason: "username_taken" };
  if (emailOwner) return { reason: "email_taken" };
  return null;
}

export async function signUp(
  input: SignUpInput,
  context: SignUpContext = {},
): Promise<SignUpResult> {
  /* Cheapest check first, and the one that works with no network. */
  if (isCommonPassword(input.password)) {
    return { ok: false, error: { reason: "password_common" } };
  }

  const breach = await checkPasswordBreached(input.password);
  if (breach.checked && breach.breached) {
    return { ok: false, error: { reason: "password_breached" } };
  }

  const phone = parsePhone(input.phone);
  if (!phone.ok) {
    return {
      ok: false,
      error: { reason: "phone_invalid", message: phone.reason },
    };
  }

  /*
   * Checked before the transaction so the common case fails fast with the
   * right field named, rather than costing an Argon2 hash and a rolled-back
   * transaction to say the same thing.
   */
  const conflict = await findConflict(input.username, input.email);
  if (conflict) return { ok: false, error: conflict };

  const passwordHash = await hashPassword(input.password);

  for (let attempt = 0; attempt <= SLUG_RETRIES; attempt++) {
    const companyId = newCompanyId();
    const verification = issueVerificationToken();

    try {
      const value = await withCompany(companyId, async (db, scoped) => {
        const company = await createCompany(db, scoped, input.companyName);

        const user = await db.user.create({
          data: {
            companyId: scoped,
            fullName: input.fullName,
            email: input.email,
            username: input.username,
            passwordHash,
            phoneE164: phone.e164,
            role: "OWNER",
            /*
             * Only stamped when the check actually completed. Left null on a
             * fail-open, which is what makes the next sign-in retry it — an
             * optimistic `now()` here would close the gap on paper and leave
             * the password unchecked forever.
             */
            ...(breach.checked ? { hibpCheckedAt: new Date() } : {}),
          },
        });

        await db.emailVerificationToken.create({
          data: {
            companyId: scoped,
            userId: user.id,
            tokenHash: verification.tokenHash,
            expiresAt: verification.expiresAt,
          },
        });

        const session = await createSessionRow(db, scoped, user.id, context);

        await auditWithin(db, scoped, {
          action: AuditAction.SIGNUP,
          userId: user.id,
          ...context,
          metadata: { slug: company.slug },
        });

        /*
         * The breach check not running is itself an event. Without this row the
         * gap left by failing open is invisible, which defeats the point of
         * failing open rather than failing closed.
         */
        if (!breach.checked) {
          await auditWithin(db, scoped, {
            action: AuditAction.HIBP_UNAVAILABLE,
            userId: user.id,
            ...context,
            metadata: { reason: breach.reason },
          });
        }

        return {
          companyId: scoped,
          userId: user.id,
          sessionToken: session.token,
          csrfSecret: session.csrfSecret,
          verificationToken: verification.token,
          breachCheckSkipped: !breach.checked,
        } satisfies SignUpSuccess;
      });

      return { ok: true, value };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      /*
       * Something was taken between the pre-check and the commit. Ask again to
       * find out what — the error itself cannot say.
       */
      const raced = await findConflict(input.username, input.email);
      if (raced) return { ok: false, error: raced };

      /*
       * Neither field is taken, so this was a slug collision: app_available_slug
       * found the slug free and a concurrent signup committed it first. Retry
       * the whole transaction, because a failed statement aborts it and there
       * is nothing to continue from. Never surfaced to the user — the company
       * name is not taken, only the derived slug was.
       */
      if (attempt < SLUG_RETRIES) continue;

      throw error;
    }
  }

  throw new Error("Could not allocate a company slug after several attempts");
}
