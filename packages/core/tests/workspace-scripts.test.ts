import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every workspace is actually reached by the gate's per-workspace commands.
 *
 * ---------------------------------------------------------------------------
 * Why this exists, and the belief it replaces
 * ---------------------------------------------------------------------------
 *
 * The conventions carried an entry for two phases claiming `npm run typecheck`
 * could not see what `next build` could, and that a test file could therefore
 * be green in one and red in the other. It sent somebody hunting for a hole in
 * the setup in Phase 9. Measured, it was wrong: the root pass covers all four
 * workspaces including their tests, proved by breaking each one.
 *
 * What was true both times anybody believed it is duller and worse - the
 * typecheck had simply not been run before committing, and the gate caught it.
 *
 * But the entry did point at a real shape of failure, just not the one it
 * described. `npm run typecheck --workspaces --if-present` skips a workspace
 * with no `typecheck` script IN SILENCE. There is no warning, the command
 * still exits zero, and a whole package stops being typechecked the moment
 * somebody adds one without the script or renames it.
 *
 * That is what this asserts. It is cheap, it needs no build, and it fails in
 * the direction that matters: a new workspace is a failing test until the gate
 * genuinely covers it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

/**
 * The scripts the root gate fans out with `--workspaces --if-present`.
 *
 * `typecheck` is the one that has already been misunderstood. `lint` and
 * `build` are deliberately NOT here: only the web workspace defines them, and
 * the root script names that workspace directly rather than fanning out - so
 * absence elsewhere is correct rather than a hole.
 */
const FANNED_OUT = ["typecheck"] as const;

function workspaceDirs(): string[] {
  const out: string[] = [];

  for (const group of ["packages", "apps"]) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;

    for (const entry of readdirSync(groupDir)) {
      const dir = join(groupDir, entry);
      if (existsSync(join(dir, "package.json"))) out.push(dir);
    }
  }

  return out;
}

function scriptsOf(dir: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe("the gate reaches every workspace", () => {
  const dirs = workspaceDirs();

  it("finds the workspaces, so a silent zero cannot pass this suite", () => {
    /*
     * The guard that makes the assertions below mean something. A broken path
     * gives an empty list, and "every workspace has a typecheck script" is
     * vacuously true of no workspaces.
     */
    expect(dirs.length).toBeGreaterThanOrEqual(4);
  });

  for (const script of FANNED_OUT) {
    it(`gives every workspace a "${script}" script`, () => {
      /*
       * `--if-present` is the whole reason this is worth asserting: a
       * workspace without the script is skipped silently and the command
       * still exits zero. Nothing anywhere reports that a package stopped
       * being checked.
       */
      const missing = dirs
        .filter((dir) => !(script in scriptsOf(dir)))
        .map((dir) => dir.slice(repoRoot.length + 1).replace(/\\/g, "/"));

      expect(
        missing.sort(),
        `these workspaces are skipped in silence by \`npm run ${script} --workspaces --if-present\``,
      ).toEqual([]);
    });
  }

  it("keeps every workspace's tests inside its own tsconfig", () => {
    /*
     * The second half of the same question. A workspace can have a typecheck
     * script that runs and covers nothing useful, if its tsconfig's `include`
     * omits the test directory - which is exactly the shape the stale
     * conventions entry described and which is NOT currently true of any
     * workspace here.
     *
     * Matched loosely on purpose. The point is that tests are named at all;
     * pinning the exact glob would turn a legitimate reorganisation into a
     * failure with a misleading message.
     */
    const uncovered: string[] = [];

    for (const dir of dirs) {
      const configPath = join(dir, "tsconfig.json");
      if (!existsSync(configPath)) continue;
      if (!existsSync(join(dir, "tests"))) continue;

      const raw = readFileSync(configPath, "utf8");

      /*
       * Matched on the RAW text, and deliberately not after stripping
       * comments.
       *
       * The first version of this stripped `/* … *\/` first, exactly as the
       * other source-level checks here do - and a tsconfig include is
       * `"tests/**\/*.ts"`, which CONTAINS `/*` and `*\/`. The stripper ate
       * the glob and reported all four workspaces as uncovered.
       *
       * That is the same fault this repository has now hit four times, and the
       * lesson is not "always strip comments" - it is that a check must match
       * something a comment cannot contain. So this matches a QUOTED token: a
       * tsconfig string always opens with `"`, and prose about tests does not.
       */
      const includesTests =
        raw.includes('"tests/') || /"\*\*\/\*\.tsx?"/.test(raw);

      if (!includesTests) {
        uncovered.push(dir.slice(repoRoot.length + 1).replace(/\\/g, "/"));
      }
    }

    expect(
      uncovered.sort(),
      "these workspaces have tests their own tsconfig does not include, so `tsc --noEmit` runs and checks nothing",
    ).toEqual([]);
  });
});
