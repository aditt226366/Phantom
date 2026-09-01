import { PDFParse } from "pdf-parse";
import type { FetchImpl } from "../providers/types.ts";

/**
 * Turning a file or a URL into text worth indexing.
 *
 * ---------------------------------------------------------------------------
 * Server-only, and published on its own subpath
 * ---------------------------------------------------------------------------
 *
 * This reaches for `pdf-parse`, which is a Node module. Importing it from a
 * "use client" component would drag a PDF engine into the browser graph - the
 * same failure the core barrel produced when it pulled `@node-rs/argon2` in
 * and built fine for six commits, and the same one `leads/hash.ts` produced
 * one directory later.
 *
 * So it is `@whatsapp-os/core/verse-server`, absent from the `verse` barrel,
 * and `client-safe-barrels.test.ts` has an entry proving the barrel does not
 * reach it.
 */

/** What extraction produced, or why it did not. */
export type Extraction =
  | { kind: "extracted"; text: string; pages?: number }
  /**
   * A failure the tenant can act on.
   *
   * The reason is a sentence, not a code, because the realistic failures here
   * all have a remedy the tenant can carry out themselves: re-export the PDF
   * with a text layer, fix the sharing on the URL, upload a different file. A
   * red dot saying FAILED sends them to support for something they could have
   * fixed in a minute.
   */
  | { kind: "failed"; reason: string };

/**
 * The shortest extraction that is worth indexing at all.
 *
 * A scanned PDF - a photograph of pages, with no text layer - extracts to a
 * handful of stray characters rather than to nothing, so "did it throw" does
 * not distinguish it from a real document. That is the single most common
 * upload failure this feature will see, and left undetected it produces a
 * knowledge base that is silently empty while every document says INDEXED.
 */
const MIN_USEFUL_CHARS = 40;

/**
 * Text out of a PDF.
 *
 * Rejects a scanned document by name rather than letting it through as a
 * near-empty success, because the failure it otherwise produces is a knowledge
 * base that looks indexed and answers nothing.
 */
export async function extractPdf(bytes: Uint8Array): Promise<Extraction> {
  let parser: PDFParse | null = null;

  try {
    parser = new PDFParse({ data: bytes });
    const result = await parser.getText();
    const text = (result.text ?? "").trim();

    if (text.length < MIN_USEFUL_CHARS) {
      return {
        kind: "failed",
        reason:
          "This PDF has no readable text - it is most likely a scan or a set " +
          "of images. Re-export it from the original document, or upload the " +
          "text another way.",
      };
    }

    return { kind: "extracted", text, pages: result.total };
  } catch (error) {
    return {
      kind: "failed",
      reason: `This PDF could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    /* The parser holds a worker. Leaking one per document turns an ingestion
       of a hundred files into a hundred live workers. */
    await parser?.destroy().catch(() => undefined);
  }
}

export function extractText(bytes: Uint8Array): Extraction {
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .trim();

  if (text.length < MIN_USEFUL_CHARS) {
    return { kind: "failed", reason: "This file has almost no text in it." };
  }

  return { kind: "extracted", text };
}

/* ------------------------------------------------------------------------- *
 * Crawling
 * ------------------------------------------------------------------------- */

/**
 * How many pages one URL document may pull in.
 *
 * A cap rather than a depth limit, because depth does not bound anything: a
 * site with a paginated archive is infinitely deep at depth two. This is the
 * number that stops a tenant pointing us at a shop with forty thousand product
 * pages and waiting while we embed all of them at their expense.
 */
export const MAX_CRAWL_PAGES = 25;

/** Same-origin only. Never follows off-site, whatever the page links to. */
export function isSameDomain(seed: URL, candidate: URL): boolean {
  return seed.protocol === candidate.protocol && seed.host === candidate.host;
}

/**
 * The robots.txt rules that apply to us.
 *
 * ---------------------------------------------------------------------------
 * Respected because it is somebody else's server
 * ---------------------------------------------------------------------------
 *
 * A tenant pointing us at a URL is not authorisation from the site's operator,
 * and the two are frequently not the same person - an agency binding a client's
 * site, somebody indexing a supplier's catalogue. robots.txt is the only
 * standing instruction that site has given about automated access, and
 * ignoring it because a tenant clicked a button is exactly the reasoning that
 * gets a crawler blocked at the network level.
 *
 * Deliberately a small parser and not a complete one. It reads User-agent
 * groups and Disallow/Allow paths, longest-match-wins, which is the part of the
 * standard that actually appears in the wild. Crawl-delay, sitemaps and
 * wildcards beyond a trailing `*` are not handled - and where it is unsure it
 * refuses, which is the safe direction for somebody else's server.
 */
export interface RobotsRules {
  /** Longest-prefix match wins, per the standard. */
  rules: ReadonlyArray<{ path: string; allow: boolean }>;
}

export function parseRobots(body: string, userAgent = "*"): RobotsRules {
  const lines = body.split(/\r?\n/);
  const groups = new Map<string, Array<{ path: string; allow: boolean }>>();

  let active: string[] = [];
  let sawDirective = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;

    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;

    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();

    if (field === "user-agent") {
      /* A new agent line after directives starts a new group; consecutive
         agent lines share one. */
      if (sawDirective) {
        active = [];
        sawDirective = false;
      }
      active.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
      continue;
    }

    if (field === "disallow" || field === "allow") {
      sawDirective = true;
      for (const agent of active) {
        groups.get(agent)?.push({ path: value, allow: field === "allow" });
      }
    }
  }

  const ours = groups.get(userAgent.toLowerCase()) ?? groups.get("*") ?? [];
  return { rules: ours };
}

export function robotsAllows(rules: RobotsRules, pathname: string): boolean {
  let best: { length: number; allow: boolean } | null = null;

  for (const rule of rules.rules) {
    /*
     * An empty Disallow means "allow everything" per the standard, and must
     * not be treated as a zero-length prefix matching every path - which is
     * the reading that blocks an entire site whose robots.txt was trying to
     * permit it.
     */
    if (rule.path === "") continue;

    const prefix = rule.path.endsWith("*") ? rule.path.slice(0, -1) : rule.path;
    if (!pathname.startsWith(prefix)) continue;

    if (best === null || prefix.length > best.length) {
      best = { length: prefix.length, allow: rule.allow };
    }
  }

  /* No rule matched: allowed. That is the standard's default, and it is also
     the only reading under which a site with no robots.txt is crawlable. */
  return best?.allow ?? true;
}

/** Fetch and parse robots.txt. A site with none allows everything. */
export async function fetchRobots(
  fetchImpl: FetchImpl,
  seed: URL,
  timeoutMs = 10_000,
): Promise<RobotsRules> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(new URL("/robots.txt", seed).toString(), {
      signal: controller.signal,
    });

    /*
     * Anything but a 200 is treated as "no rules", including a 404 and a 500.
     *
     * The alternative - refusing to crawl when robots.txt cannot be read - is
     * defensible and is the wrong trade here: a transient 500 on robots.txt
     * would silently turn a working binding into one that indexes nothing, and
     * the tenant would see a knowledge base that stopped updating with no
     * reason given.
     */
    if (!response.ok) return { rules: [] };

    return parseRobots(await response.text());
  } catch {
    return { rules: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Links on a page, absolute and same-domain, in document order.
 *
 * A regex rather than a DOM parser, deliberately. The alternative is a parsing
 * dependency for a job whose output is fed straight into a same-domain filter
 * and a page cap - so a malformed match costs one fetch that 404s, and a missed
 * one costs a page. Neither is worth a dependency that also has to be kept off
 * the client bundle.
 */
export function linksFrom(html: string, base: URL): URL[] {
  const out: URL[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1]!;
    if (/^(mailto|tel|javascript):/i.test(href)) continue;

    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }

    /* A fragment is the same page. Following them is how a crawler spends its
       whole page budget on one document's table of contents. */
    url.hash = "";

    const key = url.toString();
    if (seen.has(key)) continue;
    if (!isSameDomain(base, url)) continue;

    seen.add(key);
    out.push(url);
  }

  return out;
}

/** Visible text from an HTML page. */
export function textFromHtml(html: string): string {
  return html
    /* Script and style carry no prose and a great deal of text. */
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    /* Block-level tags become paragraph breaks, so chunkText has boundaries to
       split on rather than one undifferentiated run. */
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)\s*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    /*
     * An opening tag became a space, so `</p><p>` left "\n\n " and every
     * paragraph after the first began with one. Invisible in a diff, invisible
     * on a page, and carried all the way into the embedding.
     */
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** Pages skipped by robots.txt, so the tenant is told rather than guessing. */
  blockedByRobots: string[];
  /** True when the cap stopped it, so the UI can say "first 25 pages". */
  hitPageCap: boolean;
}

/**
 * Breadth-first, same-domain, robots-respecting, capped.
 *
 * Breadth-first rather than depth-first because the pages worth having are
 * near the seed - a business's delivery and returns pages are linked from the
 * homepage, and the deep end of a site is pagination.
 */
export async function crawl(
  fetchImpl: FetchImpl,
  seedUrl: string,
  options: { maxPages?: number; timeoutMs?: number } = {},
): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? MAX_CRAWL_PAGES;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const seed = new URL(seedUrl);

  const robots = await fetchRobots(fetchImpl, seed, timeoutMs);

  const queue: URL[] = [seed];
  const seen = new Set<string>([seed.toString()]);
  const pages: CrawledPage[] = [];
  const blockedByRobots: string[] = [];
  let hitPageCap = false;

  while (queue.length > 0) {
    if (pages.length >= maxPages) {
      hitPageCap = true;
      break;
    }

    const url = queue.shift()!;

    if (!robotsAllows(robots, url.pathname)) {
      blockedByRobots.push(url.toString());
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url.toString(), {
        signal: controller.signal,
      });
      if (!response.ok) continue;

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) continue;

      const html = await response.text();
      const text = textFromHtml(html);
      const title =
        /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ||
        url.pathname;

      if (text.length >= MIN_USEFUL_CHARS) {
        pages.push({ url: url.toString(), title, text });
      }

      for (const link of linksFrom(html, url)) {
        const key = link.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(link);
      }
    } catch {
      /* One unreachable page does not fail a crawl. The document's status
         reflects what was actually indexed, and an empty crawl fails. */
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  return { pages, blockedByRobots, hitPageCap };
}
