import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing reachable from a client-safe barrel may need Node.
 *
 * ---------------------------------------------------------------------------
 * Why this is a test and not a comment
 * ---------------------------------------------------------------------------
 *
 * Decision 10 puts the template preview and the template submission on one
 * module, which means a "use client" component imports that module — and
 * therefore imports everything it can reach. The barrel says so at the top, and
 * a comment is exactly the kind of thing that stays true until somebody adds
 * one import.
 *
 * The failure it prevents is not a compile error, which is the whole problem.
 * The core barrel dragged `@node-rs/argon2` into the browser graph and built
 * fine for six commits, because nothing rendered the component that pulled it
 * in. It surfaced as a build failure whose import trace named every file except
 * the one at fault.
 *
 * `signature.ts` is the live example of the arrangement working: it uses
 * node:crypto, so it is published as `@whatsapp-os/core/whatsapp-server` and is
 * deliberately absent from the barrel below. This test is what stops it, or
 * anything like it, drifting back in.
 *
 * Phase 6 added the second instance, which is why this is now a table rather
 * than one entry point. `leads/hash.ts` computes a row hash with node:crypto
 * and the mapping screen's preview is a client component that imports the rest
 * of that directory - the same hazard, one directory over, found by writing the
 * module rather than by a build failing later.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Every barrel a "use client" component is allowed to import, and the module
 * each one is proving it does not reach.
 *
 * `forbidden` is named per barrel rather than derived, because the generic
 * assertions below would already catch it - naming it makes deleting the
 * arrangement a visible choice instead of a test that quietly stops asserting
 * anything in particular.
 */
const BARRELS = [
  {
    name: "whatsapp",
    entry: resolve(here, "..", "src", "whatsapp", "index.ts"),
    serverSubpath: "whatsapp-server",
    forbidden: "signature.ts",
    minFiles: 5,
  },
  {
    name: "leads",
    entry: resolve(here, "..", "src", "leads", "index.ts"),
    serverSubpath: "leads-server",
    forbidden: "hash.ts",
    minFiles: 2,
  },
  {
    name: "flows",
    entry: resolve(here, "..", "src", "flows", "index.ts"),
    serverSubpath: "flows-server",
    /*
     * Nothing yet, and the entry is here anyway.
     *
     * The other two barrels each name a module they prove they do not reach,
     * because each has a server-only sibling that would be a real hazard to
     * import. The flow builder has none - the validator, the button codec and
     * the payload builder are pure - so there is nothing true to name, and
     * naming a file that does not exist would be a check that passes for the
     * wrong reason.
     *
     * The generic assertions above are the whole guard here, and they are the
     * ones that matter: the builder's node editors are client components that
     * import this barrel to validate as somebody types, so the first module in
     * this directory to reach for node:crypto fails them. The entry exists so
     * that when a flows-server sibling is written there is a place for it to
     * be named rather than a table nobody thought to add it to.
     */
    forbidden: null,
    minFiles: 3,
  },
  {
    name: "verse",
    entry: resolve(here, "..", "src", "verse", "index.ts"),
    serverSubpath: "verse-server",
    /*
     * `ingest.ts` imports pdf-parse, which is a Node module carrying a PDF
     * engine and a worker. The campaign wizard and /dev/rag are client
     * components that import this barrel - for the tier labels, the floor's
     * provenance and the chunking preview - so this is the third instance of
     * exactly the hazard the first two entries exist for.
     *
     * The first was the core barrel dragging @node-rs/argon2 into the browser
     * graph, which built fine for six commits because nothing rendered the
     * component that pulled it in.
     */
    forbidden: "ingest.ts",
    minFiles: 4,
  },
] as const;

/** Bare specifiers that are known browser-safe. Anything else is a finding. */
const ALLOWED_BARE = new Set(["zod"]);

/** `import ... from "x"`, `export ... from "x"`, and bare `import "x"`. */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const value = match[1] ?? match[2];
    if (value) found.push(value);
  }
  return found;
}

/** Every file reachable from the barrel, and every bare package it names. */
function walk(entry: string): { files: string[]; bare: string[] } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        /* The repo imports workspace sources with explicit .ts extensions, so
           this needs no resolution algorithm. */
        queue.push(resolve(dirname(file), specifier));
      } else {
        bare.add(specifier);
      }
    }
  }

  return { files: [...seen], bare: [...bare] };
}

describe.each(BARRELS)("the client-safe $name barrel", (barrel) => {
  const graph = walk(barrel.entry);

  it("reaches more than the entry file", () => {
    /* A resolution bug that silently found nothing would make every assertion
       below vacuously true, which is the way this kind of test usually rots. */
    expect(graph.files.length).toBeGreaterThan(barrel.minFiles);
  });

  it("imports no Node builtin", () => {
    const offenders = graph.files.filter((file) =>
      specifiersOf(readFileSync(file, "utf8")).some((s) => s.startsWith("node:")),
    );

    expect(
      offenders.map((f) => f.replace(/\\/g, "/").split("/src/")[1]).sort(),
      "these are reachable from a browser bundle — move them to whatsapp-server",
    ).toEqual([]);
  });

  it("imports no native package", () => {
    const native = graph.bare.filter((s) => s.startsWith("@node-rs/"));
    expect(native, "a .node binary cannot be bundled for the browser").toEqual([]);
  });

  it("names no bare package that is not known browser-safe", () => {
    const unknown = graph.bare.filter((s) => !ALLOWED_BARE.has(s));
    expect(
      unknown.sort(),
      `add it to ALLOWED_BARE with a reason, or move the importer to ${barrel.serverSubpath}`,
    ).toEqual([]);
  });

  it.skipIf(barrel.forbidden === null)(
    "does not reach the module that needs node:crypto",
    () => {
      /* The concrete case the arrangement exists for. Named rather than left to
         the generic assertions, so deleting it is a visible choice. */
      const reached = graph.files.some((f) => f.endsWith(barrel.forbidden!));
      expect(reached, `${barrel.forbidden} belongs to ${barrel.serverSubpath}`).toBe(
        false,
      );
    },
  );
});
