import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The same invariant the lint rule enforces, asserted independently.
 *
 * Both exist because they fail differently. A lint rule is silenced by an
 * `eslint-disable` comment, by a config edit, or by a CI job that runs tests
 * but skips lint. A test survives all three, and is itself a diff in a file
 * whose name says what it is for.
 *
 * These are allowlists rather than "no matches", so widening the set of files
 * holding a tenant-isolation bypass shows up as an edit to a security test
 * rather than as a quiet second entry in a lint config.
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Directories that ship to a running server or browser. */
const SCANNED = ["app", "components", "lib"];

/**
 * May hold the unscoped client.
 *
 * login_attempts is global — a sign-in attempt for a username that does not
 * exist has no company to attribute it to — so withCompany cannot scope it.
 */
const RAW_CLIENT_ALLOWED = ["lib/auth/lockout.ts"];

/** May hold the cross-company client. Exposes named queries, never the client. */
const ADMIN_CLIENT_ALLOWED = ["lib/admin-db.ts"];

function sourceFiles(): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
  }

  for (const dir of SCANNED) walk(join(webRoot, dir));
  found.push(join(webRoot, "proxy.ts"));

  return found;
}

function relativePath(file: string): string {
  return relative(webRoot, file).replace(/\\/g, "/");
}

/**
 * Import statements only, never a bare substring.
 *
 * This file and lib/admin-db.ts both name these specifiers in prose. Matching
 * on the text alone made an earlier version of this check flag itself.
 */
function importsFrom(source: string, specifier: string): boolean {
  const escaped = specifier.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
  return (
    new RegExp(`(?:^|\\n)\\s*import[^;]*from\\s+["']${escaped}["']`).test(
      source,
    ) || new RegExp(`require\\(\\s*["']${escaped}["']\\s*\\)`).test(source)
  );
}

/** Named imports pulled from a specifier, for the importNames-style check. */
function namedImportsFrom(source: string, specifier: string): string[] {
  const escaped = specifier.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
  const pattern = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s+["']${escaped}["']`,
    "g",
  );

  const names: string[] = [];
  for (const match of source.matchAll(pattern)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("the unscoped Prisma client", () => {
  it("is imported only where withCompany cannot apply", () => {
    const offenders = sourceFiles()
      .filter((file) => {
        const source = readFileSync(file, "utf8");

        /*
         * `Prisma`, `withCompany` and the model types come from the same
         * specifier and are all fine. Only the client itself is the problem.
         */
        const named = namedImportsFrom(source, "@whatsapp-os/db");
        const holdsClient =
          named.includes("prisma") || named.includes("getPrismaClient");

        return holdsClient || importsFrom(source, "@whatsapp-os/db/client");
      })
      .map(relativePath);

    expect(offenders.sort()).toEqual([...RAW_CLIENT_ALLOWED].sort());
  });

  it("leaves withCompany and the types importable", () => {
    /* A rule that banned the whole module would be unusable and get removed. */
    const session = readFileSync(
      join(webRoot, "lib", "auth", "session-store.ts"),
      "utf8",
    );
    const named = namedImportsFrom(session, "@whatsapp-os/db");

    expect(named).toContain("withCompany");
    expect(named).not.toContain("prisma");
  });
});

describe("the admin client", () => {
  it("is imported by exactly one file", () => {
    const holders = sourceFiles()
      .filter((file) =>
        importsFrom(readFileSync(file, "utf8"), "@whatsapp-os/db/admin"),
      )
      .map(relativePath);

    /*
     * An allowlist, so a second exempt file appears as a diff here — in a test
     * about tenant isolation — rather than as one more entry in a lint config.
     */
    expect(holders.sort()).toEqual([...ADMIN_CLIENT_ALLOWED].sort());
  });

  it("is not re-exported", () => {
    const source = readFileSync(join(webRoot, "lib", "admin-db.ts"), "utf8");

    expect(source).not.toMatch(/export\s*\{[^}]*\badminPrisma\b/);
    expect(source).not.toMatch(/export\s+const\s+adminPrisma\b/);
    expect(source).not.toMatch(/export\s*\*\s*from\s*["']@whatsapp-os\/db\/admin/);
  });
});

describe("the admin query surface", () => {
  it("takes scalars, never Prisma argument types", () => {
    /*
     * What keeps lib/admin-db.ts a list of named queries rather than a
     * passthrough with extra steps.
     *
     * The moment a function accepts `where`, `select` or a `…Args`, the file
     * stops bounding what the panel can read: the shape is decided at the call
     * site, the return type stops being written out, and reviewing this file no
     * longer tells you what crosses the tenant boundary. Every parameter is a
     * scalar — a company id, a provider, a search string.
     *
     * Prisma.InputJsonValue is the one exception and is not an argument type:
     * it is the shape of an audit metadata blob on the way in.
     */
    const source = readFileSync(join(webRoot, "lib", "admin-db.ts"), "utf8");

    const referenced = [
      ...new Set(
        [...source.matchAll(/\bPrisma\.(\w+)/g)].map((match) => match[1]!),
      ),
    ].sort();

    expect(referenced).toEqual(["InputJsonValue"]);
  });
});

describe("the lint rule and this test agree", () => {
  it("exempts the same files in both places", () => {
    /*
     * The two guards are only worth having if they say the same thing. If
     * someone adds an exemption to the config and not here, this fails.
     */
    const config = readFileSync(join(webRoot, "eslint.config.mjs"), "utf8");

    const exempted = [...config.matchAll(/files:\s*\["([^"]+)"\]/g)]
      .map((match) => match[1]!)
      .filter((pattern) => !pattern.includes("*"));

    expect(exempted.sort()).toEqual(
      [...RAW_CLIENT_ALLOWED, ...ADMIN_CLIENT_ALLOWED].sort(),
    );
  });
});
