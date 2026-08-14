import "server-only";
import { prisma } from "@whatsapp-os/db";

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

async function readAttempt(username: string, ip: string) {
  return prisma.loginAttempt.findUnique({
    where: { username_ip: { username, ip } },
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
): Promise<LockState> {
  const now = new Date();

  const [perIp, perUsername] = await Promise.all([
    readAttempt(username, ip),
    readAttempt(username, ALL_ADDRESSES),
  ]);

  for (const row of [perIp, perUsername]) {
    if (row?.lockedUntil && row.lockedUntil > now) {
      return { locked: true, until: row.lockedUntil };
    }
  }

  return { locked: false };
}

async function bump(
  username: string,
  ip: string,
  threshold: number,
  windowMs?: number,
): Promise<void> {
  const now = new Date();
  const existing = await readAttempt(username, ip);

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
    where: { username_ip: { username, ip } },
    create: {
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
): Promise<void> {
  await bump(username, ip, MAX_FAILURES_PER_IP);
  await bump(username, ALL_ADDRESSES, MAX_FAILURES_PER_USERNAME, USERNAME_WINDOW_MS);
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
): Promise<void> {
  await prisma.loginAttempt.updateMany({
    where: { username, ip: { in: [ip, ALL_ADDRESSES] } },
    data: { failureCount: 0, lockedUntil: null },
  });
}

/** Signup throttle, keyed on the address alone. */
export async function checkSignupAllowed(ip: string): Promise<LockState> {
  return checkLocked(SIGNUP_SENTINEL, ip);
}

export async function recordSignupAttempt(ip: string): Promise<void> {
  await bump(SIGNUP_SENTINEL, ip, MAX_SIGNUPS_PER_IP, USERNAME_WINDOW_MS);
}
