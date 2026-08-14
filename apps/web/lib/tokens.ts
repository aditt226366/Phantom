import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Reads the design tokens straight out of app/globals.css at build time.
 *
 * The styleguide could have hardcoded a copy of every value, but then it would
 * document what the tokens used to be. Parsing the real stylesheet means the
 * page cannot drift: add a token to globals.css and it appears; change a hex
 * and the swatch changes with it.
 *
 * The styleguide route is statically generated, so this read happens once at
 * build and never on a request.
 */

export interface Token {
  /** Full custom property name, e.g. "--wa-canvas". */
  name: string;
  /** Declared value, e.g. "#f5f5f5". */
  value: string;
  /** Trailing line comment, if the declaration had one. */
  note?: string;
}

export interface TokenGroup {
  /** Section number from the globals.css banner comment. */
  index: number;
  /** Section title, e.g. "COLOUR - Surface". */
  title: string;
  tokens: Token[];
}

const SECTION_HEADING = /^(\d+)\.\s+(.+?)\s*$/;
const DECLARATION = /^(--wa-[a-z0-9-]+)\s*:\s*([^;]+);(?:\s*\/\*\s*(.*?)\s*\*\/)?/;

/** Extract the body of the first `:root { ... }` block. */
function extractRootBlock(css: string): string {
  const start = css.indexOf(":root {");
  if (start === -1) return "";

  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        return css.slice(css.indexOf("{", start) + 1, i);
      }
    }
  }
  return "";
}

let cached: TokenGroup[] | undefined;

export async function readTokenGroups(): Promise<TokenGroup[]> {
  if (cached) return cached;

  const cssPath = path.join(process.cwd(), "app", "globals.css");
  const css = await readFile(cssPath, "utf8");
  const body = extractRootBlock(css);

  const groups: TokenGroup[] = [];
  let current: TokenGroup | undefined;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      current = {
        index: Number(heading[1]),
        title: heading[2] ?? "",
        tokens: [],
      };
      groups.push(current);
      continue;
    }

    const declaration = DECLARATION.exec(line);
    if (declaration && current) {
      const [, name, value, note] = declaration;
      current.tokens.push({
        name: name ?? "",
        value: (value ?? "").trim(),
        ...(note ? { note } : {}),
      });
    }
  }

  cached = groups.filter((group) => group.tokens.length > 0);
  return cached;
}

/** True when a token's value is a literal colour we can paint a swatch with. */
export function isColourToken(token: Token): boolean {
  return token.value.startsWith("#");
}

/** Look up a single token value across all groups. */
export function findToken(
  groups: TokenGroup[],
  name: string,
): string | undefined {
  for (const group of groups) {
    const hit = group.tokens.find((token) => token.name === name);
    if (hit) return hit.value;
  }
  return undefined;
}
