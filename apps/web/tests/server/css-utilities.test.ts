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
 * "does a max-width resolve to a spacing token", which catches max-w-md — a
 * class that exists and is wrong. A check for existence alone would have
 * passed the bug that actually collapsed the pages.
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

  it("never resolves a max-width to a spacing token", () => {
    /*
     * The failure that existence alone cannot catch. Tailwind builds
     * max-w-* from the spacing scale too, so a spacing key sharing a name
     * with a built-in size silently wins — and a card capped at 20px looks
     * like a layout bug rather than a config one.
     *
     * A max-width in spacing units is never what anybody means. Name the
     * token something that cannot collide, as --wa-measure-* does.
     */
    const collapsed: string[] = [];

    for (const [cls] of usedClasses()) {
      const decl = declarations.get(cls) ?? declarations.get(bareOf(cls));
      if (!decl) continue;
      if (/^\s*(max-width|min-width)\s*:\s*var\(--wa-space-/.test(decl)) {
        collapsed.push(`${cls} -> ${decl.trim()}`);
      }
    }

    expect(
      collapsed.sort(),
      "a max-width resolving to a spacing token collapses the element",
    ).toEqual([]);
  });
});

describe.skipIf(css !== null)("compiled stylesheet", () => {
  it("is absent, so the utility checks were skipped", () => {
    /* Explicit rather than silent: `npm run build` enables the checks above. */
    expect(css).toBeNull();
  });
});
