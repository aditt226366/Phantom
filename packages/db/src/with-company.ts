import { prisma } from "./client.ts";

/**
 * withCompany - a Prisma client extension that scopes every query to one company.
 *
 * The problem it solves: in a multi-tenant system, a single forgotten
 * `where: { companyId }` is a cross-tenant data leak. Relying on every call
 * site to remember is not a security model. This extension moves the filter
 * from convention into the client itself, so a scoped client is incapable of
 * reading or writing another company's rows.
 *
 *     const db = withCompany(session.companyId);
 *     await db.user.findMany();             // WHERE company_id = $1, always
 *     await db.user.create({ data: {...} }); // company_id injected
 *
 * How it works, per operation:
 *   - reads / updates / deletes -> `companyId` is merged into `where`
 *   - creates                   -> `companyId` is merged into `data`
 *   - upsert                    -> both
 *
 * Merging companyId into the `where` of findUnique/update/delete relies on
 * Prisma's extended-where-unique behaviour (GA since Prisma 5): additional
 * non-unique filters are allowed alongside the unique selector. The practical
 * effect is that `db.user.findUnique({ where: { id } })` for another company's
 * id returns null rather than that company's row.
 *
 * ---------------------------------------------------------------------------
 * LIMITS - read these before relying on it
 * ---------------------------------------------------------------------------
 *
 * 1. Raw queries are NOT scoped. `$queryRaw`, `$executeRaw` and friends do not
 *    pass through the model-level query hook. Any raw SQL must filter by
 *    company_id by hand.
 *
 * 2. Nested writes are NOT scoped. A `create` with a nested `posts: { create:
 *    [...] }` only gets companyId on the top-level record. Write nested
 *    children explicitly, or extend this to walk the payload.
 *
 * 3. A model is only scoped if it is listed in COMPANY_SCOPED_MODELS below.
 *    Adding a company-scoped model to schema.prisma means adding it here too -
 *    that is the one manual step.
 *
 * ---------------------------------------------------------------------------
 * THIS SIGNATURE IS TEMPORARY
 * ---------------------------------------------------------------------------
 *
 * This is still the Phase 0 application-layer guard, renamed and nothing more.
 * It becomes `withCompany(companyId, async (db) => ...)` - a callback running
 * inside an interactive transaction that sets `app.company_id` for Postgres
 * row-level security to read - in the RLS commit. Do not build call sites on
 * the current shape expecting it to survive.
 */

/**
 * Models carrying a `company_id` column.
 *
 * `Company` itself is deliberately absent: it has no company_id, and scoping it
 * would break company lookup entirely.
 */
export const COMPANY_SCOPED_MODELS = new Set<string>(["User"]);

/** Operations whose `where` clause should be narrowed to the company. */
const WHERE_SCOPED_OPERATIONS = new Set<string>([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
]);

type AnyArgs = Record<string, unknown>;

function mergeWhere(args: AnyArgs, companyId: string): AnyArgs {
  const where = (args["where"] as AnyArgs | undefined) ?? {};
  return { ...args, where: { ...where, companyId } };
}

function mergeCreateData(args: AnyArgs, companyId: string): AnyArgs {
  const data = args["data"];

  if (Array.isArray(data)) {
    return {
      ...args,
      data: data.map((row) => ({ ...(row as AnyArgs), companyId })),
    };
  }

  return { ...args, data: { ...(data as AnyArgs), companyId } };
}

/**
 * Build a company-scoped client.
 *
 * Returns a new extended client; the base `prisma` singleton is untouched, so
 * unscoped access remains available for company provisioning and admin paths
 * that genuinely need it.
 */
export function withCompany(companyId: string) {
  if (!companyId) {
    throw new Error("withCompany requires a non-empty companyId");
  }

  return prisma.$extends({
    name: "withCompany",
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          if (!COMPANY_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          const next = args as AnyArgs;

          switch (operation) {
            case "create":
            case "createMany":
            case "createManyAndReturn":
              return query(mergeCreateData(next, companyId));

            case "upsert":
              return query({
                ...mergeWhere(next, companyId),
                create: {
                  ...(next["create"] as AnyArgs),
                  companyId,
                },
              });

            default:
              if (WHERE_SCOPED_OPERATIONS.has(operation)) {
                return query(mergeWhere(next, companyId));
              }
              return query(next);
          }
        },
      },
    },
  });
}

/** The type of a company-scoped client, for passing around in service code. */
export type CompanyClient = ReturnType<typeof withCompany>;
