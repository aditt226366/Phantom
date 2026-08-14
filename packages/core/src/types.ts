/**
 * Shared ambient types.
 *
 * Runtime values live in schemas.ts / queues.ts / encryption.ts. This file is
 * types only - it must stay free of imports that carry a runtime cost, so it
 * is safe to pull into a client component.
 */

/** Every company-scoped operation carries one of these. */
export interface CompanyContext {
  companyId: string;
}

/** Result of a service call that can fail in an expected, non-exceptional way. */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Make selected keys of T optional. */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** A JSON-serialisable value. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };
