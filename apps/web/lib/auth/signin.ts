import "server-only";
import {
  checkPasswordBreached,
  verifyDummy,
  verifyPassword,
  type SignInInput,
} from "@whatsapp-os/core";
import { AuditAction, resolveCompany, withCompany } from "@whatsapp-os/db";
import { auditWithin } from "./audit.ts";
import { checkLocked, clearFailures, recordFailure } from "./lockout.ts";
import { createSessionRow } from "./session-store.ts";

/**
 * Verify a username and password.
 *
 * ---------------------------------------------------------------------------
 * Every branch below is shaped by one requirement
 * ---------------------------------------------------------------------------
 *
 * A response must not reveal whether an account exists. That is three separate
 * disciplines, and getting two of them right is worth nothing:
 *
 *   Response — one message for every failure. "No such user" and "wrong
 *   password" are the same string, produced by the same return.
 *
 *   Timing — an unknown username runs verifyDummy(), a real Argon2id
 *   verification against a throwaway hash. Skipping it returns in microseconds
 *   against ~100ms for a real account, which is trivially measurable.
 *
 *   Side effects — the lockout counters are written identically whether or not
 *   the username exists. This is the one that gets forgotten: if only real
 *   accounts ever lock out, an attacker learns which usernames are real by
 *   trying six times and seeing whether the message changes.
 */

export type SignInFailure =
  | { reason: "invalid_credentials" }
  | { reason: "locked"; until: Date };

export interface SignInSuccess {
  companyId: string;
  userId: string;
  sessionToken: string;
  csrfSecret: string;
}

export type SignInResult =
  | { ok: true; value: SignInSuccess }
  | { ok: false; error: SignInFailure };

export interface SignInContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

interface DeferredBreachCheck {
  /** Merged into the user update inside the session transaction. */
  userUpdate: {
    hibpCheckedAt?: Date;
    passwordBreachedAt?: Date;
  };
  audit?: {
    action: AuditAction;
    metadata?: Record<string, string>;
  };
}

/**
 * Retry the breach check that signup could not complete.
 *
 * Three outcomes, and the third is the one that matters:
 *
 *   checked, clean    stamp hibpCheckedAt — done, never runs again
 *   checked, breached stamp both; the password is flagged for rotation
 *   not checked       change nothing at all
 *
 * The last one is deliberate. Stamping hibpCheckedAt after a failed lookup
 * would record that the control had run when it had not, and the password
 * would never be checked again — the same silent gap this feature exists to
 * close, moved one step later and made permanent.
 */
async function runDeferredBreachCheck(
  user: { hibpCheckedAt: Date | null },
  password: string,
): Promise<DeferredBreachCheck> {
  if (user.hibpCheckedAt !== null) return { userUpdate: {} };

  const breach = await checkPasswordBreached(password);

  if (!breach.checked) {
    return {
      userUpdate: {},
      audit: {
        action: AuditAction.HIBP_UNAVAILABLE,
        metadata: { reason: breach.reason, at: "signin" },
      },
    };
  }

  const now = new Date();

  if (breach.breached) {
    return {
      userUpdate: { hibpCheckedAt: now, passwordBreachedAt: now },
      audit: { action: AuditAction.PASSWORD_BREACHED },
    };
  }

  return {
    userUpdate: { hibpCheckedAt: now },
    audit: { action: AuditAction.HIBP_CHECKED },
  };
}

export async function signIn(
  input: SignInInput,
  context: SignInContext = {},
): Promise<SignInResult> {
  const ip = context.ip ?? "unknown";

  /* Before any password work, and identical for unknown usernames. */
  const lock = await checkLocked(input.username, ip);
  if (lock.locked) {
    return { ok: false, error: { reason: "locked", until: lock.until! } };
  }

  const companyId = await resolveCompany("username", input.username);

  if (!companyId) {
    /*
     * Unknown username. Burn the same CPU and take the same write path, then
     * return the same error a wrong password produces.
     *
     * No audit row: audit_log is company-scoped and there is no company here.
     * login_attempts carries it instead.
     */
    await verifyDummy(input.password);
    await recordFailure(input.username, ip);
    return { ok: false, error: { reason: "invalid_credentials" } };
  }

  const user = await withCompany(companyId, (db) =>
    db.user.findUnique({
      where: { username: input.username },
      select: { id: true, passwordHash: true, hibpCheckedAt: true },
    }),
  );

  if (!user) {
    /*
     * The resolver found a company but the row is gone — a delete between the
     * two lookups. Same path as an unknown username.
     */
    await verifyDummy(input.password);
    await recordFailure(input.username, ip);
    return { ok: false, error: { reason: "invalid_credentials" } };
  }

  const valid = await verifyPassword(user.passwordHash, input.password);

  if (!valid) {
    await recordFailure(input.username, ip);

    await withCompany(companyId, (db, scoped) =>
      auditWithin(db, scoped, {
        action: AuditAction.LOGIN_FAILED,
        userId: user.id,
        ...context,
      }),
    );

    return { ok: false, error: { reason: "invalid_credentials" } };
  }

  /* failureCount only. lockoutCount persists so the backoff keeps escalating. */
  await clearFailures(input.username, ip);

  /*
   * The deferred breach check.
   *
   * Runs only when signup failed open, and only after the password has been
   * verified — checking an unverified guess would send attacker-supplied
   * hashes to HaveIBeenPwned and burn the shared quota. This is also the only
   * moment the plaintext exists again: the stored value is an Argon2id hash,
   * and HIBP is indexed by SHA-1 of the password itself.
   *
   * Deliberately before the transaction opens, like every other network call:
   * an interactive transaction holds a pooled connection and times out after
   * five seconds, and this can take three.
   *
   * The cost lands on one sign-in per affected user, and only after an outage.
   */
  const deferred = await runDeferredBreachCheck(user, input.password);

  const session = await withCompany(companyId, async (db, scoped) => {
    const created = await createSessionRow(db, scoped, user.id, context);

    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), ...deferred.userUpdate },
    });

    await auditWithin(db, scoped, {
      action: AuditAction.LOGIN,
      userId: user.id,
      ...context,
    });

    if (deferred.audit) {
      await auditWithin(db, scoped, {
        action: deferred.audit.action,
        userId: user.id,
        ...context,
        ...(deferred.audit.metadata
          ? { metadata: deferred.audit.metadata }
          : {}),
      });
    }

    return created;
  });

  return {
    ok: true,
    value: {
      companyId,
      userId: user.id,
      sessionToken: session.token,
      csrfSecret: session.csrfSecret,
    },
  };
}
