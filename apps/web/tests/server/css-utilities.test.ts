import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every class the app uses must resolve to a real rule.
 *
 * ---------------------------------------------------------------------------
 * What shipped without this
 * ---------------------------------------------------------------------------
 *
 * Two failures, both invisible to every other check:
 *
 *   max-w-md   resolved, but to the wrong value. Tailwind derives max-width
 *              utilities from the spacing scale as well as its own, so this
 *              config's `spacing.md` (20px) overrode the built-in size of the
 *              same name (28rem). Every auth card, every empty state and one
 *              table cell was capped at 20px — narrower than a single word.
 *
 *   w-button   did not resolve at all. `height.button` existed, `width.button`
 *              did not, so the icon button variant — which also sets p-0 — had
 *              no width whatsoever.
 *
 * Neither is a type error, neither throws, and cn() merges them happily. The
 * suite was green through six UI commits.
 *
 * ---------------------------------------------------------------------------
 * Two checks, because the two failures are different
 * ---------------------------------------------------------------------------
 *
 * The first is "does a rule exist", which catches w-button. The second is
 * "is an element's extent taken from the spacing scale", which catches
 * max-w-md — a class that exists and is wrong. A check for existence alone
 * would have passed the bug that actually collapsed the pages.
 *
 * The second check covers the whole size family rather than the one utility
 * that shipped broken; see its own comment for why that is not scope creep.
 *
 * This reads the compiled stylesheet, so it needs a build. It is skipped with
 * a clear message rather than failing when .next is absent, because a
 * developer running the suite before their first build should not be told the
 * CSS is broken.
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const chunks = join(webRoot, ".next", "static", "chunks");

/** Directories Tailwind scans, per tailwind.config.ts `content`. */
const SCANNED = ["app", "components", "lib"];

/**
 * Classes that legitimately have no rule in our stylesheet.
 *
 * lucide-react stamps `lucide lucide-<name>` on every icon it renders. They
 * are the library's own hooks for consumers who want to style icons globally;
 * this app styles icons with utilities instead, so they match nothing here and
 * that is correct.
 */
function isLibraryClass(cls: string): boolean {
  return cls === "lucide" || cls.startsWith("lucide-");
}

/** Our own hand-written helpers, declared in globals.css. */
function isProjectClass(cls: string): boolean {
  return cls.startsWith("wa-");
}

function sourceFiles(): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry)) found.push(full);
    }
  }

  for (const dir of SCANNED) walk(join(webRoot, dir));
  return found;
}

/**
 * Class names as written in source.
 *
 * Only string literals in a className or a cva/cn argument are considered —
 * a class built at runtime from a variable cannot be checked here, and
 * Tailwind cannot see it either, which is its own reason not to write one.
 */
function usedClasses(): Map<string, string[]> {
  const uses = new Map<string, string[]>();

  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    const where = relative(webRoot, file).replace(/\\/g, "/");

    /* Any double-quoted or backticked string that looks like a class list. */
    for (const match of source.matchAll(/(?:className|class)\s*[=:]\s*["`]([^"`]*)["`]/g)) {
      collect(match[1]!, where, uses);
    }
    /* cva/cn variant maps: bare string values in an object literal. */
    for (const match of source.matchAll(/:\s*"([a-z0-9][^"]*)"/gi)) {
      const value = match[1]!;
      if (/(^|\s)(flex|grid|w-|h-|max-w|min-w|p[xytblr]?-|m[xytblr]?-|text-|bg-|border|rounded|gap-|size-)/.test(value)) {
        collect(value, where, uses);
      }
    }
  }

  return uses;
}

function collect(list: string, where: string, uses: Map<string, string[]>): void {
  for (const raw of list.split(/\s+/)) {
    if (!raw) continue;
    if (raw.includes("$") || raw.includes("{")) continue;
    /* Arbitrary values compile to their own escaped selectors; skip. */
    if (raw.includes("[")) continue;

    /*
     * Kept whole, prefix and all. Tailwind emits `.tablet\:flex-row`, not
     * `.flex-row`, so a class used only behind a variant has no bare rule and
     * stripping the prefix reports it missing. The first version of this test
     * did exactly that and produced thirteen false positives.
     */
    if (!/^[a-z0-9][a-z0-9./:-]*$/i.test(raw)) continue;

    const at = uses.get(raw) ?? [];
    if (!at.includes(where)) at.push(where);
    uses.set(raw, at);
  }
}

/** The utility without its variant prefix, for a value lookup. */
function bareOf(cls: string): string {
  return cls.includes(":") ? cls.slice(cls.lastIndexOf(":") + 1) : cls;
}

function compiledCss(): string | null {
  if (!existsSync(chunks)) return null;
  const sheets = readdirSync(chunks).filter((f) => f.endsWith(".css"));
  if (sheets.length === 0) return null;
  return sheets.map((f) => readFileSync(join(chunks, f), "utf8")).join("\n");
}

const css = compiledCss();

describe.skipIf(css === null)("every utility used resolves to a rule", () => {
  const sheet = css ?? "";

  /** Selector class names present in the sheet. */
  const defined = new Set<string>();
  for (const match of sheet.matchAll(/\.((?:[-\w.]|\\.)+)/g)) {
    defined.add(match[1]!.replace(/\\/g, ""));
  }

  /** class -> its declaration block, for value checks. */
  const declarations = new Map<string, string>();
  for (const match of sheet.matchAll(/\.((?:[-\w.]|\\.)+)\{([^}]*)\}/g)) {
    const name = match[1]!.replace(/\\/g, "");
    if (!declarations.has(name)) declarations.set(name, match[2]!);
  }

  it("found a compiled stylesheet and some classes", () => {
    /* A wrong path here would make everything below vacuously pass. */
    expect(defined.size).toBeGreaterThan(200);
    expect(usedClasses().size).toBeGreaterThan(100);
  });

  it("emits a rule for every class the source names", () => {
    const missing: string[] = [];

    for (const [cls, where] of usedClasses()) {
      const bare = bareOf(cls);
      if (isLibraryClass(bare) || isProjectClass(bare)) continue;
      /* The prefixed selector is what Tailwind emits; the bare one covers a
         utility written without a variant. Either is proof it compiled. */
      if (defined.has(cls) || defined.has(bare)) continue;
      missing.push(`${cls}  (${where.join(", ")})`);
    }

    expect(
      missing.sort(),
      "these classes compile to nothing — the element gets no style and nothing warns",
    ).toEqual([]);
  });

  it("never sizes an element from a spacing token", () => {
    /*
     * The failure that existence alone cannot catch.
     *
     * Tailwind builds its size utilities from the spacing scale as well as its
     * own named scale, and the config's key wins. This system names spacing
     * xs, sm, base, md, lg, xl and xxl — every one of which is also a Tailwind
     * size name. So `max-w-md` is 20px, `w-xl` is 32px, `h-lg` is 24px, and
     * each of them reads in source as the size it is not.
     *
     * max-w-md is the one that shipped. It was not the bug; it was one draw
     * from a bag of seven names across eight utility prefixes, and the next
     * draw is as likely as that one was. So the rule covers the family:
     *
     *     w-  min-w-  max-w-  h-  min-h-  max-h-  size-  basis-
     *
     * Padding, margin and gap are untouched — those are *supposed* to come
     * from the spacing scale, and p-md meaning 20px is the system working.
     * What is never intended is a box whose extent is a gap.
     *
     * The fix is always a name that cannot collide, as --wa-measure-narrow
     * does, never a different spacing key.
     */
    /**
     * The exceptions, each with its reason.
     *
     * A rule about a whole family has legitimate exceptions, and the way this
     * repo handles those is the way GLOBAL_TABLES does in the schema
     * invariants: name them here with a justification, so opting out is a
     * visible diff inside the test rather than a loophole in it.
     *
     * A *height* from the spacing scale is the honest case — a 4px rule is
     * exactly one spacing base, and that is what it means to be one. A width
     * from it almost never is, which is why nothing below is a width.
     */
    const INTENDED = new Map([
      ["h-xxs", "the plan-distribution bar is a 4px rule, which is the base unit"],
      [
        "h-sm",
        "the dashboard's delivery ladder is a 12px stacked bar. Thicker than " +
          "the 4px rules above it because it carries seven segments that have " +
          "to be told apart, and 12px genuinely is three base units - the " +
          "same case as h-xxs, not a max-w-md-style collapse",
      ],
    ]);

    const SIZE_PROPERTIES = [
      "width",
      "min-width",
      "max-width",
      "height",
      "min-height",
      "max-height",
      "flex-basis",
    ];

    /* `size-*` sets width and height together, `basis-*` sets flex-basis, and
       the shorthand `flex: … var(--x)` some versions emit carries the basis
       in third position. Matching on the declaration text rather than on the
       class prefix means a renamed utility cannot slip past. */
    const pattern = new RegExp(
      `(^|;)\\s*(${SIZE_PROPERTIES.join("|")})\\s*:\\s*var\\(--wa-space-`,
    );

    const sized: string[] = [];

    for (const [cls, where] of usedClasses()) {
      const bare = bareOf(cls);
      if (INTENDED.has(bare)) continue;

      const decl = declarations.get(cls) ?? declarations.get(bare);
      if (!decl) continue;
      if (!pattern.test(decl)) continue;

      const property = pattern.exec(decl)?.[2];
      sized.push(
        `${cls} -> ${property}:var(--wa-space-…)  (${where.join(", ")})`,
      );
    }

    expect(
      sized.sort(),
      "an extent taken from the spacing scale is a collapsed element, not a small one",
    ).toEqual([]);
  });
});

describe.skipIf(css !== null)("compiled stylesheet", () => {
  it("is absent, so the utility checks were skipped", () => {
    /* Explicit rather than silent: `npm run build` enables the checks above. */
    expect(css).toBeNull();
  });
});
