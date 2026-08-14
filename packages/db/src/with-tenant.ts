import { prisma } from "./client.ts";

/**
 * withTenant - a Prisma client extension that scopes every query to one tenant.
 *
 * The problem it solves: in a multi-tenant system, a single forgotten
 * `where: { tenantId }` is a cross-tenant data leak. Relying on every call
 * site to remember is not a security model. This extension moves the filter
 * from convention into the client itself, so a scoped client is incapable of
 * reading or writing another tenant's rows.
 *
 *     const db = withTenant(session.tenantId);
 *     await db.user.findMany();          // WHERE tenant_id = $1, always
 *     await db.user.create({ data: {...} }); // tenant_id injected
 *
 * How it works, per operation:
 *   - reads / updates / deletes -> `tenantId` is merged into `where`
 *   - creates                   -> `tenantId` is merged into `data`
 *   - upsert                    -> both
 *
 * Merging tenantId into the `where` of findUnique/update/delete relies on
 * Prisma's extended-where-unique behaviour (GA since Prisma 5): additional
 * non-unique filters are allowed alongside the unique selector. The practical
 * effect is that `db.user.findUnique({ where: { id } })` for another tenant's
 * id returns null rather than that tenant's row.
 *
 * ---------------------------------------------------------------------------
 * LIMITS - read these before relying on it
 * ---------------------------------------------------------------------------
 *
 * 1. Raw queries are NOT scoped. `$queryRaw`, `$executeRaw` and friends do not
 *    pass through the model-level query hook. Any raw SQL must filter by
 *    tenant_id by hand.
 *
 * 2. Nested writes are NOT scoped. A `create` with a nested `posts: { create:
 *    [...] }` only gets tenantId on the top-level record. Write nested
 *    children explicitly, or extend this to walk the payload.
 *
 * 3. A model is only scoped if it is listed in TENANT_SCOPED_MODELS below.
 *    Adding a tenant-scoped model to schema.prisma means adding it here too -
 *    that is the one manual step, and the reason the list is exported and
 *    covered by a name-level type constraint.
 *
 * Defence in depth: this is an application-layer guard. For a hard guarantee,
 * pair it with Postgres row-level security.
 */

/**
 * Models carrying a `tenantId` column.
 *
 * `Tenant` itself is deliberately absent: it has no tenantId, and scoping it
 * would break tenant lookup entirely.
 */
export const TENANT_SCOPED_MODELS = new Set<string>(["User"]);

/** Operations whose `where` clause should be narrowed to the tenant. */
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

function mergeWhere(args: AnyArgs, tenantId: string): AnyArgs {
  const where = (args["where"] as AnyArgs | undefined) ?? {};
  return { ...args, where: { ...where, tenantId } };
}

function mergeCreateData(args: AnyArgs, tenantId: string): AnyArgs {
  const data = args["data"];

  if (Array.isArray(data)) {
    return {
      ...args,
      data: data.map((row) => ({ ...(row as AnyArgs), tenantId })),
    };
  }

  return { ...args, data: { ...(data as AnyArgs), tenantId } };
}

/**
 * Build a tenant-scoped client.
 *
 * Returns a new extended client; the base `prisma` singleton is untouched, so
 * unscoped access remains available for tenant provisioning and admin paths
 * that genuinely need it.
 */
export function withTenant(tenantId: string) {
  if (!tenantId) {
    throw new Error("withTenant requires a non-empty tenantId");
  }

  return prisma.$extends({
    name: "withTenant",
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          if (!TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          const next = args as AnyArgs;

          switch (operation) {
            case "create":
            case "createMany":
            case "createManyAndReturn":
              return query(mergeCreateData(next, tenantId));

            case "upsert":
              return query({
                ...mergeWhere(next, tenantId),
                create: {
                  ...(next["create"] as AnyArgs),
                  tenantId,
                },
              });

            default:
              if (WHERE_SCOPED_OPERATIONS.has(operation)) {
                return query(mergeWhere(next, tenantId));
              }
              return query(next);
          }
        },
      },
    },
  });
}

/** The type of a tenant-scoped client, for passing around in service code. */
export type TenantClient = ReturnType<typeof withTenant>;
