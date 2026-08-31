import "server-only";
import { LoginScope, prisma } from "@whatsapp-os/db";

export { LoginScope };

/**
 * Failed-attempt counters and lockout.
 *
 * login_attempts is a global table — deliberately, and the reason is worth
 * restating: an attempt on a username that does not exist has no company to
 * attribute it to. Refusing to record those would make the *absence* of a
 * lockout row an oracle for which usernames are real, which is precisely what
 * the dummy-hash timing work exists to prevent.
 *
 * The raw client is used here rather than withCompany, and that is correct
 * rather than a shortcut: this runs before any company context exists, and the
 * table has no company_id to scope by. It is one of the handful of places the
 * unscoped client is legitimate, and it touches exactly one global table.
 *
 * ---------------------------------------------------------------------------
 * The counting rule, stated once
 * ---------------------------------------------------------------------------
 *
 *   Attempts 1-5 each fail with "wrong credentials" and increment failureCount.
 *   Reaching 5 sets lockedUntil.
 *   Attempt 6 is refused with "locked" before any password is checked.
 *
 * So a user gets five real tries, not four and not six.
 */

/** Failures allowed per (username, ip) before that pair is locked. */
export const MAX_FAILURES_PER_IP = 5;

/**
 * Failures allowed per username across every address.
 *
 * Per-IP lockout alone is defeated by rotating addresses, which is exactly what
 * credential stuffing does. This second counter is looser so it does not fire
 * on a shared office NAT, but it is low enough to matter against a botnet.
 */
export const MAX_FAILURES_PER_USERNAME = 25;

/** Sentinel in the ip column for the per-username aggregate row. */
export const ALL_ADDRESSES = "*";

/**
 * Sentinel in the username column for signup throttling.
 *
 * Signup has no username to key on, and leaving it unthrottled means one script
 * can create unlimited companies and burn the HaveIBeenPwned quota for
 * everybody. Reusing this table rather than adding another keeps it to no
 * schema change; '@' cannot appear in a real username, which the
 * ^[a-z0-9_.]{3,32}$ rule guarantees.
 */
export const SIGNUP_SENTINEL = "@signup";

export const MAX_SIGNUPS_PER_IP = 5;

/**
 * Sentinel in the username column for webhook throttling.
 *
 * The same shape signup uses, and for the same reason: there is no username to
 * key on. '@' cannot appear in a real username, which the ^[a-z0-9_.]{3,32}$
 * rule guarantees.
 *
 * What is NOT keyed on is the point. Throttling per webhook key would let
 * anyone who learns a tenant's URL flood it until that key locks out - after
 * which genuine Meta deliveries are refused, failures accumulate, and Meta
 * disables the subscription in about seven days. An attacker severing a
 * customer's WhatsApp using our own protection. So the key is the source
 * address, and only the address.
 */
export const WEBHOOK_SENTINEL = "@webhook";

/**
 * Failures from one address before it is locked out.
 *
 * Deliberately generous next to MAX_FAILURES_PER_IP, because the two are
 * protecting different things. Sign-in throttling is guarding an account; this
 * is guarding a decrypt.
 *
 * The route checks this BEFORE resolving anything, so a flood already costs
 * only one indexed lookup per request. What the threshold buys is a ceiling on
 * the expensive path - resolve, decrypt, verify, insert - not on the endpoint.
 *
 * And it has to tolerate a bad day. A signature failure is what genuine Meta
 * traffic looks like when a tenant's stored app secret is stale (P5), so a
 * tight threshold would lock out Meta itself over a configuration mistake and
 * keep dropping real messages after it was fixed.
 */
export const MAX_WEBHOOK_FAILURES_PER_IP = 60;

const BASE_LOCKOUT_MS = 15 * 60 * 1_000;
const MAX_LOCKOUT_MS = 24 * 60 * 60 * 1_000;
const USERNAME_WINDOW_MS = 60 * 60 * 1_000;

/**
 * How long the nth lockout lasts: 15m, 30m, 1h, 2h … capped at a day.
 *
 * lockoutCount is never reset by a successful sign-in — only failureCount is.
 * An attacker who gets in once should not get a fresh 15-minute budget.
 */
export function lockoutDurationMs(lockoutCount: number): number {
  const exponent = Math.max(0, lockoutCount - 1);
  return Math.min(BASE_LOCKOUT_MS * 2 ** exponent, MAX_LOCKOUT_MS);
}

export interface LockState {
  locked: boolean;
  until?: Date | undefined;
}

async function readAttempt(scope: LoginScope, username: string, ip: string) {
  return prisma.loginAttempt.findUnique({
    where: { scope_username_ip: { scope, username, ip } },
  });
}

/**
 * Is this attempt refused before we even look at the password?
 *
 * Checked for both the per-IP and per-username rows. The caller must run this
 * identically for usernames that do not exist — a lockout that only ever fires
 * for real accounts tells an attacker which accounts are real.
 */
export async function checkLocked(
  username: string,
  ip: string,
  scope: LoginScope = LoginScope.TENANT,
): Promise<LockState> {
  const now = new Date();

  const [perIp, perUsername] = await Promise.all([
    readAttempt(scope, username, ip),
    readAttempt(scope, username, ALL_ADDRESSES),
  ]);

  for (const row of [perIp, perUsername]) {
    if (row?.lockedUntil && row.lockedUntil > now) {
      return { locked: true, until: row.lockedUntil };
    }
  }

  return { locked: false };
}

async function bump(
  scope: LoginScope,
  username: string,
  ip: string,
  threshold: number,
  windowMs?: number,
): Promise<void> {
  const now = new Date();
  const existing = await readAttempt(scope, username, ip);

  /*
   * The aggregate row counts within a rolling window; without that, twenty-four
   * mistyped passwords spread over a year would eventually lock an account out
   * of nowhere.
   */
  const windowExpired =
    windowMs !== undefined &&
    existing !== null &&
    now.getTime() - existing.lastFailureAt.getTime() > windowMs;

  const failureCount = windowExpired ? 1 : (existing?.failureCount ?? 0) + 1;
  const lockoutCount = existing?.lockoutCount ?? 0;

  const reached = failureCount >= threshold;
  const nextLockoutCount = reached ? lockoutCount + 1 : lockoutCount;

  const lockedUntil = reached
    ? new Date(now.getTime() + lockoutDurationMs(nextLockoutCount))
    : (existing?.lockedUntil ?? null);

  await prisma.loginAttempt.upsert({
    where: { scope_username_ip: { scope, username, ip } },
    create: {
      scope,
      username,
      ip,
      failureCount,
      lockoutCount: nextLockoutCount,
      lastFailureAt: now,
      lockedUntil,
    },
    update: {
      /* Reset to 0 on lock, so the next window starts clean. */
      failureCount: reached ? 0 : failureCount,
      lockoutCount: nextLockoutCount,
      lastFailureAt: now,
      lockedUntil,
    },
  });
}

/** Record a failed sign-in against both the per-IP and per-username counters. */
export async function recordFailure(
  username: string,
  ip: string,
  scope: LoginScope = LoginScope.TENANT,
): Promise<void> {
  await bump(scope, username, ip, MAX_FAILURES_PER_IP);
  await bump(
    scope,
    username,
    ALL_ADDRESSES,
    MAX_FAILURES_PER_USERNAME,
    USERNAME_WINDOW_MS,
  );
}

/**
 * Clear the failure count after a successful sign-in.
 *
 * failureCount only. lockoutCount persists, so the backoff keeps escalating for
 * an account that is repeatedly attacked.
 */
export async function clearFailures(
  username: string,
  ip: string,
  scope: LoginScope = LoginScope.TENANT,
): Promise<void> {
  await prisma.loginAttempt.updateMany({
    where: { scope, username, ip: { in: [ip, ALL_ADDRESSES] } },
    data: { failureCount: 0, lockedUntil: null },
  });
}

/** Signup throttle, keyed on the address alone. */
export async function checkSignupAllowed(ip: string): Promise<LockState> {
  return checkLocked(SIGNUP_SENTINEL, ip);
}

export async function recordSignupAttempt(ip: string): Promise<void> {
  await bump(
    LoginScope.TENANT,
    SIGNUP_SENTINEL,
    ip,
    MAX_SIGNUPS_PER_IP,
    USERNAME_WINDOW_MS,
  );
}

/**
 * Webhook throttle, keyed on the hashed source address alone.
 *
 * `ipHash`, not `ip`. The endpoint is unauthenticated and reachable by anyone,
 * so the addresses reaching it are not a set this system chose; storing them
 * raw would turn a throttle counter into a log of who probed us. hashIp is
 * one-way and keyed.
 *
 * Its own LoginScope member, so webhook counters cannot collide with a
 * sign-in's - the row key is (scope, username, ip), and a shared scope would
 * let an address locked out of the webhook be locked out of signing in.
 */
export async function checkWebhookAllowed(ipHash: string): Promise<LockState> {
  return checkLocked(WEBHOOK_SENTINEL, ipHash, LoginScope.WEBHOOK);
}

/**
 * Count one delivery that did not resolve or did not verify.
 *
 * Only those. A request carrying a key that resolves and a signature that
 * verifies is Meta, its decrypt is cached, and the work left is one insert - so
 * it is never counted and never throttled, however much of it arrives.
 */
export async function recordWebhookFailure(ipHash: string): Promise<void> {
  await bump(
    LoginScope.WEBHOOK,
    WEBHOOK_SENTINEL,
    ipHash,
    MAX_WEBHOOK_FAILURES_PER_IP,
    USERNAME_WINDOW_MS,
  );
}

/**
 * Forget an address's failures after a delivery that did verify.
 *
 * The recovery path, and the reason it matters: a stale app secret makes
 * genuine Meta traffic fail its signature, so Meta's own addresses accumulate
 * failures through no fault of their own. Once the tenant fixes the secret, the
 * first delivery that verifies clears the count rather than leaving it to
 * expire - otherwise the fix appears not to have worked for another hour.
 */
export async function clearWebhookFailures(ipHash: string): Promise<void> {
  await clearFailures(WEBHOOK_SENTINEL, ipHash, LoginScope.WEBHOOK);
}
