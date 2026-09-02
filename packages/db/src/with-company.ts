import { createId } from "@paralleldrive/cuid2";
import { prisma } from "./client.ts";

/**
 * withCompany - run a unit of work scoped to exactly one company.
 *
 *     const users = await withCompany(session.companyId, async (db) => {
 *       return db.user.findMany();
 *     });
 *
 * Two layers, doing different jobs:
 *
 *   1. It opens a transaction and sets `app.company_id` on that connection, so
 *      Postgres' row-level security policies scope every statement inside —
 *      including raw SQL, including anything this file never sees. That is the
 *      actual security boundary.
 *
 *   2. It still merges companyId into `where` and into `data` for the models in
 *      COMPANY_SCOPED_MODELS. This is defence in depth for reads, but it is
 *      load-bearing for writes: without it every create() would need companyId
 *      passed by hand, and forgetting once produces an opaque "new row violates
 *      row-level security policy" instead of simply working.
 *
 * ---------------------------------------------------------------------------
 * Why a callback, and not `withCompany(id).user.findMany()`
 * ---------------------------------------------------------------------------
 *
 * Because `SET` on a pooled connection outlives the request that set it.
 *
 * The driver hands out connections from a pool. A plain `SET app.company_id`
 * would persist on that connection after the query finished, and the next
 * borrower — a different request, a different tenant — would inherit it. The
 * setting has to be transaction-local, and that requires every statement in the
 * unit of work to run on one pinned connection, which is exactly what an
 * interactive transaction gives.
 *
 * The callback shape is what makes that guarantee expressible. It is not a
 * stylistic preference.
 *
 * ---------------------------------------------------------------------------
 * Keep slow work out of the callback
 * ---------------------------------------------------------------------------
 *
 * A transaction holds a pooled connection for its whole duration and Prisma
 * times it out after 5 seconds. HTTP calls, password hashing and anything else
 * that is not a database statement belong *before* the callback, not inside it.
 * The default timeout is left in place deliberately, so that a violation fails
 * loudly in development rather than quietly exhausting the pool in production.
 */

/**
 * Models carrying a `company_id` column.
 *
 * `Company` is deliberately absent: its tenant key is `id`, so injecting a
 * `companyId` filter would produce invalid queries. Its RLS policy covers it.
 *
 * Adding a company-scoped model to schema.prisma means adding it here too. The
 * schema-invariants test fails if a table has a company_id column and no
 * policy, which is the backstop for forgetting.
 */
export const COMPANY_SCOPED_MODELS = new Set<string>([
  "User",
  "Integration",
  "IntegrationSecret",
  "IntegrationVerification",
  "UsageEvent",
  "WhatsAppNumber",
  "Contact",
  "Conversation",
  "Message",
  "WhatsAppMedia",
  "WhatsAppWebhookEvent",
  "WhatsAppTemplate",
  "WhatsAppTemplateEdit",
  "KycDocument",
  "Broadcast",
  "BroadcastRecipient",
  "LeadSource",
  "LeadSourceRow",
  "DashboardRollup",
  "Flow",
  "FlowVersion",
  "FlowRun",
  "FlowRunStep",
  "KnowledgeBase",
  "KbDocument",
  "KbChunk",
  "KbChunkSource",
  "VerseCampaign",
  "VerseCampaignRecipient",
]);

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

/**
 * Reject a create that names a different company than the active scope.
 *
 * Without this the injected companyId simply overwrites whatever the caller
 * passed. That is safe — the row lands in the current company, never the
 * requested one — but it is silent, and a call site that believes it is writing
 * to company B while scoped to A is a bug that should not be quietly corrected
 * into working code. Raw SQL taking the same shape is refused by the RLS policy;
 * this makes the ORM path refuse it too, and for a legible reason.
 */
function assertScopeMatches(row: AnyArgs | undefined, companyId: string): void {
  const supplied = row?.["companyId"];

  if (typeof supplied === "string" && supplied !== companyId) {
    throw new Error(
      `withCompany(${companyId}) cannot create a row for company ${supplied}. ` +
        "Open a scope for that company instead of passing companyId by hand.",
    );
  }
}

function mergeCreateData(args: AnyArgs, companyId: string): AnyArgs {
  const data = args["data"];

  if (Array.isArray(data)) {
    return {
      ...args,
      data: data.map((row) => {
        assertScopeMatches(row as AnyArgs, companyId);
        return { ...(row as AnyArgs), companyId };
      }),
    };
  }

  assertScopeMatches(data as AnyArgs, companyId);
  return { ...args, data: { ...(data as AnyArgs), companyId } };
}

/**
 * The extension is built once, at module scope. Building it per call would
 * allocate a fresh client wrapper on every request for no benefit.
 */
function buildExtendedClient(companyId: string) {
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

type ExtendedClient = ReturnType<typeof buildExtendedClient>;

/**
 * The client handed to a withCompany callback.
 *
 * These are Prisma's ITXClientDenyList, spelled out rather than imported so it
 * does not depend on a runtime-internal export path. The practical effect worth
 * knowing: `$transaction` is absent, so nesting withCompany inside withCompany
 * is a compile error. Prisma does not support nested interactive transactions;
 * a service that needs company-scoped access should take `db: CompanyClient`
 * as a parameter instead of opening its own scope.
 */
export type CompanyClient = Omit<
  ExtendedClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

export interface WithCompanyOptions {
  /** Milliseconds the transaction may run. Prisma's default is 5000. */
  timeout?: number;
  /** Milliseconds to wait for a free connection. Prisma's default is 2000. */
  maxWait?: number;
}

/**
 * Generate a company id.
 *
 * Needed because the RLS policy on `companies` only permits inserting a row
 * whose id matches the current context — so the id has to exist before the
 * transaction opens. See the row-level-security migration.
 */
export function newCompanyId(): string {
  return createId();
}

/**
 * The callback receives the scope's companyId as a second argument.
 *
 * The runtime injection cannot be expressed in Prisma's generated types, which
 * still require companyId on a create. Rather than cast that away — casts are
 * where type errors go to hide — the scope is handed to the caller so writes
 * can name it explicitly:
 *
 *     withCompany(id, async (db, companyId) => {
 *       await db.user.create({ data: { companyId, email } });
 *     });
 *
 * Explicit and checked: assertScopeMatches rejects a value that disagrees with
 * the scope, so writing it out cannot introduce the bug it looks like it might.
 */
export async function withCompany<T>(
  companyId: string,
  callback: (db: CompanyClient, companyId: string) => Promise<T>,
  options: WithCompanyOptions = {},
): Promise<T> {
  if (!companyId) {
    throw new Error("withCompany requires a non-empty companyId");
  }

  const client = buildExtendedClient(companyId);

  return client.$transaction(async (tx) => {
    /*
     * set_config(..., is_local = true) is the function form of SET LOCAL: the
     * value is reverted when this transaction ends, so it cannot leak to the
     * next borrower of this pooled connection.
     *
     * SET LOCAL itself accepts no bind parameters, so it would have to be
     * built by string concatenation — an injection hole on a value that
     * decides which tenant's data is visible. set_config is an ordinary
     * expression and parameterises normally. Use the function form.
     */
    await tx.$queryRaw`SELECT set_config('app.company_id', ${companyId}, true)`;

    return callback(tx, companyId);
  }, options);
}
