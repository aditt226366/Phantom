import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every limited read has a total ordering.
 *
 * ---------------------------------------------------------------------------
 * Why a limit changes what a missing tiebreak costs
 * ---------------------------------------------------------------------------
 *
 * `ORDER BY` on a column that is not unique constrains nothing between tied
 * rows: Postgres returns them in whatever order the plan yields, and is free to
 * yield a different one tomorrow for the same rows. Without a limit that is a
 * presentation bug - the page reorders itself between two loads, and the
 * reader's eye learns a position that is not real.
 *
 * With a limit it stops being presentation. Rows tied at the boundary are
 * interchangeable, so the database returns six of the eight and no two runs
 * need agree on which six. The two that vanished are unseen precisely because
 * they are not on the page. Nothing looks wrong: the list is full, any count
 * beside it is computed separately and stays right, and the rows that are
 * there are correct.
 *
 * Under keyset pagination it is worse again. The next page starts after the
 * cursor row IN THIS ORDERING, so if the ordering does not place that row
 * uniquely, rows tied with it fall on either side of the boundary and are
 * skipped entirely or shown twice.
 *
 * ---------------------------------------------------------------------------
 * Why this is a source-level check and not a behavioural one
 * ---------------------------------------------------------------------------
 *
 * Totality is a syntactic property - does the ordering end on a unique column -
 * so it can be read off the source, and the behavioural tests that exist
 * alongside this one (dashboard-ordering, verse-ordering, admin-pagination)
 * each cover a single call site. This covers all of them and, more to the
 * point, the ones written next year.
 *
 * The ties are not hypothetical. Every one of these was found holding a real
 * tie in the fixture or in production shape: Meta's refresh writes an account's
 * numbers in one pass; a broadcast advances every recipient's conversation to
 * one `occurredAt`; a campaign audience is one INSERT; a Google Sheets poll
 * writes a page of rows in one transaction; an integration check runs against
 * every integration at once. `created_at` ties are the normal case in this
 * system, not the exotic one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

/** Where queries are written. Generated clients and tests are not source. */
const ROOTS = [
  join(repoRoot, "apps", "web", "app"),
  join(repoRoot, "apps", "web", "lib"),
  join(repoRoot, "apps", "worker", "src"),
  join(repoRoot, "packages", "db", "src"),
];

const SKIP_DIRS = new Set(["generated", "node_modules", ".next", "tests"]);

/**
 * Columns that make an ordering total on their own.
 *
 * `id` only. Every model in schema.prisma has `id` as its primary key, so it is
 * unique by construction rather than by a constraint somebody could drop. A
 * column that merely HAS a unique index is not enough here: uniqueness is often
 * composite (`@@unique([companyId, name, language])`), and one member of a
 * composite unique is not itself unique.
 */
const TOTAL_COLUMNS = new Set(["id"]);

/**
 * Limited reads whose order genuinely cannot matter, each with a reason.
 *
 * Empty, and that is a finding rather than an oversight: every limited read in
 * this repository currently feeds something a person reads or something the
 * send path acts on. The list exists so that a legitimate case has somewhere to
 * go - a guard whose only legitimate use it refuses gets deleted rather than
 * fixed, and this repository has met that shape more than once.
 *
 * An entry is `"<path>:<line>"` with a comment saying why the order is not
 * observable. "It is only a count" is a reason; "it has never mattered" is not.
 */
const ORDER_INDEPENDENT: string[] = [];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceFiles(full));
      continue;
    }

    if (/\.tsx?$/.test(entry)) out.push(full);
  }

  return out;
}

/** The balanced `{ … }` starting at `open`. */
function balanced(src: string, open: number): string {
  let depth = 0;

  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }

  return src.slice(open);
}

/**
 * The ordering keys of every array literal in an `orderBy` expression.
 *
 * An array per branch, because `orderBy` is sometimes a ternary - the inbox
 * orders one way for the feed and another for the queue, and BOTH have to be
 * total. A bare object (`orderBy: { id: "asc" }`) is treated as a
 * single-element ordering.
 */
function orderingsOf(expression: string): string[][] {
  const orderings: string[][] = [];
  const arrays = expression.match(/\[[^[\]]*\]/g);

  if (arrays) {
    for (const array of arrays) {
      orderings.push([...array.matchAll(/(\w+)\s*:/g)].map((m) => m[1]!));
    }
    return orderings;
  }

  const object = expression.match(/\{[^{}]*\}/);
  if (object) {
    orderings.push([...object[0].matchAll(/(\w+)\s*:/g)].map((m) => m[1]!));
  }

  return orderings;
}

interface LimitedRead {
  where: string;
  ordering: string | null;
  lastKeys: string[];
}

function limitedReads(file: string): LimitedRead[] {
  const src = readFileSync(file, "utf8");
  const found: LimitedRead[] = [];

  for (const match of src.matchAll(/\.findMany\(\s*\{/g)) {
    const open = src.indexOf("{", match.index!);
    const body = balanced(src, open);

    /*
     * Matched at the START of a line, after nothing but whitespace.
     *
     * That is the point, and it is the fourth time this repository has had to
     * make it: a check must key on something a comment cannot contain. Prose
     * about ordering says "orderBy" all the time - the comments this very
     * commit added say it - but a line inside a block comment begins with `*`,
     * and a single-line one begins with `/*` or `//`. None of them can begin
     * with `orderBy:`. Stripping comments first is what ate a tsconfig glob.
     *
     * `take[:,]` and not `take:`, which is the hole this check shipped with for
     * one draft. A helper that takes its own limit as a parameter passes it as
     * the shorthand `take,` - and three do, including nextCampaignRecipients on
     * the campaign send path, which is the most consequential limited read in
     * the system. Matching only `take:` skipped all three in silence and the
     * suite was green, which is the same outcome as having no check. It was
     * found by breaking all seven call sites at once and counting the failures:
     * six came back, not seven.
     */
    if (!/^[ \t]*take[:,]/m.test(body)) continue;

    const line = src.slice(0, match.index!).split("\n").length;
    const where = `${relative(repoRoot, file).replace(/\\/g, "/")}:${line}`;

    const orderByAt = body.search(/^[ \t]*orderBy:/m);

    if (orderByAt === -1) {
      found.push({ where, ordering: null, lastKeys: [] });
      continue;
    }

    /* To the next top-level key, which is where the expression ends. */
    const rest = body.slice(orderByAt);
    const end = rest.search(/\n[ \t]*(take|select|where|cursor|skip|include|distinct):/);
    const expression = end === -1 ? rest : rest.slice(0, end);

    const orderings = orderingsOf(expression);

    found.push({
      where,
      ordering: expression.replace(/\s+/g, " ").trim().slice(0, 90),
      lastKeys: orderings.map((keys) => keys[keys.length - 1] ?? ""),
    });
  }

  return found;
}

describe("a query with a limit has a total ordering", () => {
  const reads = ROOTS.flatMap((root) => sourceFiles(root)).flatMap(limitedReads);

  it("finds the limited reads, so an empty sweep cannot pass this suite", () => {
    /*
     * The guard that makes the assertion below mean something. A broken path or
     * a regex that stopped matching gives an empty list, and "every limited
     * read is totally ordered" is vacuously true of none.
     */
    expect(reads.length).toBeGreaterThanOrEqual(15);
  });

  it("ends every one of them on a unique column", () => {
    const offenders = reads
      .filter((read) => !ORDER_INDEPENDENT.includes(read.where))
      .filter(
        (read) =>
          read.lastKeys.length === 0 ||
          read.lastKeys.some((key) => !TOTAL_COLUMNS.has(key)),
      )
      .map((read) =>
        read.ordering === null
          ? `${read.where} — take with no orderBy at all`
          : `${read.where} — ends on "${read.lastKeys.join('" / "')}": ${read.ordering}`,
      );

    expect(
      offenders.sort(),
      "these reads take a LIMIT over an ordering that does not place rows uniquely, so which rows come back is up to the query plan — add `{ id: \"asc\" }` as the last key, or name it in ORDER_INDEPENDENT with a reason",
    ).toEqual([]);
  });
});
