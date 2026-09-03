import { describe, expect, it, vi } from "vitest";

import {
  crawl,
  extractText,
  isSameDomain,
  linksFrom,
  MAX_CRAWL_PAGES,
  parseRobots,
  robotsAllows,
  textFromHtml,
} from "../src/verse/ingest.ts";

/**
 * Extraction and crawling.
 *
 * The crawl assertions are about restraint rather than capability: what it
 * refuses to fetch is the whole point. A crawler that follows off-site links,
 * ignores robots.txt or has no page cap is one that gets a tenant's IP blocked
 * and bills them for embedding somebody else's website.
 */

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

describe("extractText", () => {
  it("decodes utf-8", () => {
    const bytes = new TextEncoder().encode(
      "Refunds are available within 14 days of delivery, no exceptions.",
    );
    const result = extractText(bytes);

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") throw new Error("unreachable");
    expect(result.text).toContain("14 days");
  });

  it("refuses a file with almost nothing in it", () => {
    /*
     * The empty-document case matters because the alternative is a knowledge
     * base full of documents marked INDEXED that answer nothing, which looks
     * like a retrieval problem for a long time before anybody checks the
     * chunk counts.
     */
    expect(extractText(new TextEncoder().encode("hi")).kind).toBe("failed");
  });

  it("gives a failure a sentence, not a code", () => {
    const result = extractText(new Uint8Array());
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.reason.length).toBeGreaterThan(10);
  });
});

describe("isSameDomain", () => {
  const seed = new URL("https://kamat.example/handbook");

  it("accepts the same host and protocol", () => {
    expect(isSameDomain(seed, new URL("https://kamat.example/returns"))).toBe(true);
  });

  it.each([
    "https://other.example/page",
    "https://sub.kamat.example/page",
    "http://kamat.example/page",
  ])("refuses %s", (candidate) => {
    /*
     * A subdomain is a different host and is refused deliberately. A tenant
     * binding shop.example must not pull in blog.example or, worse, an
     * unrelated tenant of the same hosting provider.
     */
    expect(isSameDomain(seed, new URL(candidate))).toBe(false);
  });
});

describe("robots.txt", () => {
  it("applies the wildcard group when no agent matches us", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private");

    expect(robotsAllows(rules, "/public")).toBe(true);
    expect(robotsAllows(rules, "/private/page")).toBe(false);
  });

  it("lets the longest match win, so Allow can carve out of Disallow", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /docs\nAllow: /docs/public",
    );

    expect(robotsAllows(rules, "/docs/secret")).toBe(false);
    expect(robotsAllows(rules, "/docs/public/faq")).toBe(true);
  });

  it("treats an empty Disallow as allowing everything", () => {
    /*
     * The reading that matters. `Disallow:` with no path is the standard's way
     * of saying "nothing is disallowed", and treating it as a zero-length
     * prefix matching every path blocks an entire site whose robots.txt was
     * trying to permit it.
     */
    const rules = parseRobots("User-agent: *\nDisallow:");
    expect(robotsAllows(rules, "/anything")).toBe(true);
  });

  it("allows everything when there are no rules at all", () => {
    expect(robotsAllows(parseRobots(""), "/anything")).toBe(true);
  });

  it("ignores comments and blank lines", () => {
    const rules = parseRobots("# a comment\n\nUser-agent: *\nDisallow: /x # trailing");
    expect(robotsAllows(rules, "/x/y")).toBe(false);
  });

  it("handles a trailing wildcard", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /tmp*");
    expect(robotsAllows(rules, "/tmp/page")).toBe(false);
  });
});

describe("linksFrom", () => {
  const base = new URL("https://kamat.example/index.html");

  it("resolves relative links against the page", () => {
    const links = linksFrom('<a href="/returns">Returns</a>', base);
    expect(links.map(String)).toEqual(["https://kamat.example/returns"]);
  });

  it("drops off-site links", () => {
    const links = linksFrom(
      '<a href="https://elsewhere.example/x">x</a><a href="/ok">ok</a>',
      base,
    );
    expect(links.map(String)).toEqual(["https://kamat.example/ok"]);
  });

  it.each(["mailto:a@b.example", "tel:+911234", "javascript:void(0)"])(
    "drops %s",
    (href) => {
      expect(linksFrom(`<a href="${href}">x</a>`, base)).toEqual([]);
    },
  );

  it("strips fragments and de-duplicates", () => {
    /*
     * Following fragments is how a crawler spends its whole page budget on one
     * document's table of contents.
     */
    const links = linksFrom(
      '<a href="/a#one">1</a><a href="/a#two">2</a><a href="/a">3</a>',
      base,
    );
    expect(links.map(String)).toEqual(["https://kamat.example/a"]);
  });
});

describe("textFromHtml", () => {
  it("drops script and style content", () => {
    const text = textFromHtml(
      "<style>.a{color:red}</style><p>Delivery in 3-5 days.</p><script>var x=1</script>",
    );

    expect(text).toContain("Delivery in 3-5 days.");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("var x");
  });

  it("turns block tags into paragraph breaks", () => {
    /* So chunkText has boundaries to split on rather than one long run. */
    const text = textFromHtml("<p>One.</p><p>Two.</p>");
    expect(text).toBe("One.\n\nTwo.");
  });

  it("decodes the entities that actually appear in prose", () => {
    expect(textFromHtml("<p>Tea &amp; coffee &lt;hot&gt;</p>")).toContain(
      "Tea & coffee <hot>",
    );
  });
});

describe("crawl", () => {
  it("stays on the seed domain and follows links breadth-first", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/robots.txt")) return textResponse("");
      if (href === "https://kamat.example/")
        return htmlResponse(
          "<title>Home</title><p>Kamat Textiles delivers across Maharashtra " +
            'in three to five working days.</p><a href="/returns">r</a>' +
            '<a href="https://elsewhere.example/x">off</a>',
        );
      if (href === "https://kamat.example/returns")
        return htmlResponse(
          "<title>Returns</title><p>Returns are accepted within fourteen days of delivery.</p>",
        );
      return htmlResponse("not found", 404);
    });

    const result = await crawl(
      fetchImpl as unknown as typeof fetch,
      "https://kamat.example/",
    );

    expect(result.pages.map((page) => page.url)).toEqual([
      "https://kamat.example/",
      "https://kamat.example/returns",
    ]);
    /* Nothing off-site was even fetched. */
    expect(
      fetchImpl.mock.calls.some((call) => String(call[0]).includes("elsewhere")),
    ).toBe(false);
  });

  it("respects robots.txt and reports what it skipped", async () => {
    /*
     * A tenant clicking a button is not authorisation from the site's
     * operator, and the two are frequently different people. robots.txt is the
     * only standing instruction that site has given about automated access.
     */
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/robots.txt"))
        return textResponse("User-agent: *\nDisallow: /private");
      if (href === "https://kamat.example/")
        return htmlResponse(
          "<title>Home</title><p>The home page carries enough prose to be " +
            'worth indexing on its own.</p><a href="/private/secret">s</a>' +
            '<a href="/open">o</a>',
        );
      if (href === "https://kamat.example/open")
        return htmlResponse("<title>Open</title><p>Anyone may read this page here.</p>");
      return htmlResponse("secret", 200);
    });

    const result = await crawl(
      fetchImpl as unknown as typeof fetch,
      "https://kamat.example/",
    );

    expect(result.blockedByRobots).toEqual([
      "https://kamat.example/private/secret",
    ]);
    expect(
      fetchImpl.mock.calls.some((call) => String(call[0]).includes("/private/")),
    ).toBe(false);
  });

  it("stops at the page cap and says so", async () => {
    /*
     * A cap rather than a depth limit, because depth bounds nothing: a
     * paginated archive is infinitely deep at depth two. Without this a tenant
     * points us at a shop with forty thousand product pages and pays to embed
     * all of them.
     */
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/robots.txt")) return textResponse("");
      const index = Number(/\/p(\d+)/.exec(href)?.[1] ?? 0);
      return htmlResponse(
        `<title>P${index}</title><p>Page ${index} has some genuine prose on it here.</p>` +
          `<a href="/p${index + 1}">next</a><a href="/p${index + 2}">skip</a>`,
      );
    });

    const result = await crawl(
      fetchImpl as unknown as typeof fetch,
      "https://kamat.example/p0",
      { maxPages: 5 },
    );

    expect(result.pages).toHaveLength(5);
    expect(result.hitPageCap).toBe(true);
  });

  it("defaults to a cap rather than to unlimited", () => {
    expect(MAX_CRAWL_PAGES).toBeGreaterThan(0);
    expect(MAX_CRAWL_PAGES).toBeLessThanOrEqual(100);
  });

  it("skips non-HTML responses", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/robots.txt")) return textResponse("");
      if (href === "https://kamat.example/")
        return htmlResponse(
          "<title>H</title><p>The home page carries enough prose to be worth " +
            'indexing on its own.</p><a href="/f.pdf">pdf</a>',
        );
      return new Response("%PDF-1.4", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    });

    const result = await crawl(
      fetchImpl as unknown as typeof fetch,
      "https://kamat.example/",
    );

    expect(result.pages.map((page) => page.url)).toEqual([
      "https://kamat.example/",
    ]);
  });

  it("survives one unreachable page without failing the crawl", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/robots.txt")) return textResponse("");
      if (href === "https://kamat.example/")
        return htmlResponse(
          "<title>H</title><p>The home page carries enough prose to be worth " +
            'indexing on its own.</p><a href="/broken">b</a>' +
            '<a href="/good">g</a>',
        );
      if (href === "https://kamat.example/broken") throw new Error("ECONNRESET");
      return htmlResponse(
        "<title>Good</title><p>This page loaded perfectly well and carries " +
          "enough prose to be worth indexing.</p>",
      );
    });

    const result = await crawl(
      fetchImpl as unknown as typeof fetch,
      "https://kamat.example/",
    );

    expect(result.pages.map((page) => page.url)).toEqual([
      "https://kamat.example/",
      "https://kamat.example/good",
    ]);
  });

  it("treats an unreadable robots.txt as no rules rather than as a refusal", async () => {
    /*
     * Deliberate, and the opposite trade from the rest of this file. Refusing
     * to crawl when robots.txt 500s would silently turn a working binding into
     * one that indexes nothing, and the tenant would see a knowledge base that
     * stopped updating with no reason given.
     */
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/robots.txt")) return textResponse("boom", 500);
      return htmlResponse(
        "<title>H</title><p>A page carrying comfortably more than the " +
          "minimum number of characters worth indexing.</p>",
      );
    });

    const result = await crawl(
      fetchImpl as unknown as typeof fetch,
      "https://kamat.example/",
    );

    expect(result.pages).toHaveLength(1);
  });
});
