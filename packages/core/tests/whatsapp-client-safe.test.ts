import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing reachable from `@whatsapp-os/core/whatsapp` may need Node.
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
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(here, "..", "src", "whatsapp", "index.ts");

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

describe("the client-safe whatsapp barrel", () => {
  const graph = walk(ENTRY);

  it("reaches more than the entry file", () => {
    /* A resolution bug that silently found nothing would make every assertion
       below vacuously true, which is the way this kind of test usually rots. */
    expect(graph.files.length).toBeGreaterThan(5);
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
      "add it to ALLOWED_BARE with a reason, or move the importer to whatsapp-server",
    ).toEqual([]);
  });

  it("does not reach the signature module, which needs node:crypto", () => {
    /* The concrete case the arrangement exists for. Named rather than left to
       the generic assertions, so deleting it is a visible choice. */
    const reached = graph.files.some((f) => f.endsWith("signature.ts"));
    expect(reached, "signature.ts belongs to whatsapp-server").toBe(false);
  });
});
