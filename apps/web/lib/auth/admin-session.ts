import "server-only";
import { cache } from "react";
import { hashIp } from "./ip-hash.ts";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  generateCsrfSecret,
  hashToken,
  issueSessionToken,
  safeEqual,
  verifyDummy,
  verifyPassword,
} from "@whatsapp-os/core";
import {
  createAdminSessionRow,
  findAdminByUsername,
  findAdminSessionByTokenHash,
  recordAdminLogin,
  revokeAdminSessionByTokenHash,
  touchAdminSession,
  writeAdminAudit,
} from "@/lib/admin-db";
import {
  ADMIN_CSRF_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  CSRF_COOKIE_OPTIONS,
  CSRF_FIELD_NAME,
  EXPIRED_COOKIE_OPTIONS,
  SESSION_COOKIE_OPTIONS,
} from "./cookies.ts";
import { checkLocked, clearFailures, recordFailure, LoginScope } from "./lockout.ts";

/**
 * Platform admin sessions.
 *
 * A parallel implementation of the tenant session, on purpose. It shares the
 * cookie attributes and the token discipline — the two things that must not
 * drift — and shares nothing else:
 *
 *   - different table (admin_sessions), so an admin token in the tenant cookie
 *     resolves to nothing rather than to something informative;
 *   - never reachable through app_resolve_company, which only knows about
 *     users, sessions and verification tokens, all of which carry a company_id;
 *   - a different lockout scope, so an admin and a tenant user sharing a
 *     username cannot lock each other out.
 *
 * There is no role flag anywhere. Escalating a tenant session into an admin one
 * would require forging a token in a table the tenant role cannot even read.
 */

const RENEW_AFTER_MS = 24 * 60 * 60 * 1_000;

export interface AdminSessionContext {
  sessionId: string;
  adminUserId: string;
  username: string;
  csrfSecret: string;
}

export const getAdminSession = cache(
  async (): Promise<AdminSessionContext | null> => {
    const store = await cookies();
    const token = store.get(ADMIN_SESSION_COOKIE_NAME)?.value;
    if (!token) return null;

    return resolveAdminSessionByToken(token);
  },
);

export async function resolveAdminSessionByToken(
  rawToken: string,
): Promise<AdminSessionContext | null> {
  if (!rawToken) return null;

  const session = await findAdminSessionByTokenHash(hashToken(rawToken));

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  if (Date.now() - session.lastSeenAt.getTime() > RENEW_AFTER_MS) {
    const { expiresAt } = issueSessionToken();
    await touchAdminSession(session.id, expiresAt);
  }

  return {
    sessionId: session.id,
    adminUserId: session.adminUserId,
    username: session.adminUser.username,
    csrfSecret: session.csrfSecret,
  };
}

/** Every admin loader and action calls this. Redirects to the ADMIN sign-in. */
export async function requireAdminSession(): Promise<AdminSessionContext> {
  const session = await getAdminSession();
  if (!session) {
    /* Never the tenant /sign-in — a different account space entirely. */
    redirect("/admin/sign-in");
  }
  return session;
}

export type AdminSignInResult =
  | { ok: true }
  | { ok: false; reason: "invalid_credentials" | "locked" };

export async function adminSignIn(
  username: string,
  password: string,
  context: { ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<AdminSignInResult> {
  const ip = context.ip ?? "unknown";
  const normalised = username.trim().toLowerCase();

  const lock = await checkLocked(normalised, ip, LoginScope.ADMIN);
  if (lock.locked) return { ok: false, reason: "locked" };

  const admin = await findAdminByUsername(normalised);

  if (!admin) {
    /* Same shape, same cost, same write path as a wrong password. */
    await verifyDummy(password);
    await recordFailure(normalised, ip, LoginScope.ADMIN);
    return { ok: false, reason: "invalid_credentials" };
  }

  if (!(await verifyPassword(admin.passwordHash, password))) {
    await recordFailure(normalised, ip, LoginScope.ADMIN);
    await writeAdminAudit({
      adminUserId: admin.id,
      action: "admin.login_failed",
      ...(context.ip ? { ip: context.ip } : {}),
    });
    return { ok: false, reason: "invalid_credentials" };
  }

  await clearFailures(normalised, ip, LoginScope.ADMIN);

  const { token, tokenHash, expiresAt } = issueSessionToken();
  const csrfSecret = generateCsrfSecret();

  await createAdminSessionRow({
    adminUserId: admin.id,
    tokenHash,
    csrfSecret,
    expiresAt,
    ...(context.ip ? { ipHash: hashIp(context.ip) } : {}),
    ...(context.userAgent ? { userAgent: context.userAgent } : {}),
  });

  await recordAdminLogin(admin.id);
  await writeAdminAudit({
    adminUserId: admin.id,
    action: "admin.login",
    ...(context.ip ? { ip: context.ip } : {}),
  });

  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
  store.set(ADMIN_CSRF_COOKIE_NAME, csrfSecret, CSRF_COOKIE_OPTIONS);

  return { ok: true };
}

export async function endAdminSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(ADMIN_SESSION_COOKIE_NAME)?.value;

  if (token) {
    await revokeAdminSessionByTokenHash(hashToken(token));
  }

  store.set(ADMIN_SESSION_COOKIE_NAME, "", EXPIRED_COOKIE_OPTIONS);
  store.set(ADMIN_CSRF_COOKIE_NAME, "", EXPIRED_COOKIE_OPTIONS);
}

/** CSRF for admin forms, against the admin cookie and the admin session row. */
export async function assertAdminCsrf(
  formData: FormData,
  session?: AdminSessionContext | null,
): Promise<void> {
  const submitted = formData.get(CSRF_FIELD_NAME);
  if (typeof submitted !== "string" || submitted.length === 0) {
    throw new Error("Missing CSRF token");
  }

  const store = await cookies();
  const cookieToken = store.get(ADMIN_CSRF_COOKIE_NAME)?.value;
  if (!cookieToken) throw new Error("Missing CSRF cookie");

  if (!safeEqual(submitted, cookieToken)) {
    throw new Error("CSRF token does not match");
  }

  if (session && !safeEqual(submitted, session.csrfSecret)) {
    throw new Error("CSRF token is not bound to this session");
  }
}

export async function readAdminCsrfToken(): Promise<string> {
  const store = await cookies();
  return store.get(ADMIN_CSRF_COOKIE_NAME)?.value ?? "";
}
