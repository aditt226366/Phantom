import { z } from "zod";

/**
 * Reusable primitives.
 *
 * Every value entering the system from outside - a request body, a query
 * string, a webhook, a job payload - is parsed by a Zod schema before it is
 * used. These are the shared building blocks; feature-specific schemas
 * compose them.
 */

/** A cuid2-style identifier, as produced by Prisma's @default(cuid()). */
export const idSchema = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/i, "Not a valid id");

export const companyIdSchema = idSchema.describe("Company id");

export const emailSchema = z
  .email("Not a valid email address")
  .max(320)
  .transform((value) => value.trim().toLowerCase());

/**
 * E.164 phone number, the format WhatsApp and every telephony provider
 * expects: a leading +, a non-zero country digit, up to 15 digits total.
 */
export const e164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone number must be in E.164 format, e.g. +14155550123");

/** A non-empty, trimmed, length-capped string. */
export const shortTextSchema = z.string().trim().min(1).max(255);

/** Cursor pagination, the shape every list endpoint should accept. */
export const paginationSchema = z.object({
  cursor: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type Pagination = z.infer<typeof paginationSchema>;

/* -------------------------------------------------------------------------
   Admin listing
   ------------------------------------------------------------------------- */

export const COMPANY_STATUS_FILTERS = ["all", "active", "deactivated"] as const;

export type CompanyStatusFilter = (typeof COMPANY_STATUS_FILTERS)[number];

/**
 * The companies list, as it appears in the URL.
 *
 * Extends paginationSchema rather than declaring its own cursor and limit: a
 * second pagination shape is a second set of bounds to get wrong, and the one
 * that matters here is `max(100)` — this list is every tenant on the
 * installation, and it is unbounded by design.
 *
 * Search and status live in the query string, not in component state, so the
 * page stays a server component running a real filtered query. Fetching every
 * company and filtering in the browser would ship the whole customer list to
 * the client and stop working at exactly the point it matters. It also makes
 * the view bookmarkable, back-button-able, and linkable into a support thread.
 */
export const companyFilterSchema = paginationSchema.extend({
  /** Matched against company name, slug and owner username. */
  q: z.string().trim().max(120).optional(),
  status: z.enum(COMPANY_STATUS_FILTERS).default("all"),
});

export type CompanyFilter = z.infer<typeof companyFilterSchema>;

/* -------------------------------------------------------------------------
   Health
   ------------------------------------------------------------------------- */

/** Response contract for GET /api/health. */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  db: z.boolean(),
  redis: z.boolean(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/* -------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */

/**
 * Parse an unknown body and return a discriminated result rather than
 * throwing, so route handlers can map failures onto a 400 without try/catch.
 */
export function safeParseInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
):
  | { ok: true; data: z.infer<T> }
  | { ok: false; errors: Array<{ path: string; message: string }> } {
  const result = schema.safeParse(input);

  if (result.success) {
    return { ok: true, data: result.data };
  }

  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  };
}
