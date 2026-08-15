import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

/**
 * A public HTTPS origin that forwards to the local web app.
 *
 * Meta cannot POST to localhost, and every interesting property of the webhook
 * path is invisible without a real delivery: the X-Hub-Signature-256 body has
 * to be the exact bytes Meta signed, delivery statuses only arrive out of order
 * when a real network reorders them, and a template approval callback comes
 * hours after the submission that caused it. Replaying a captured payload with
 * curl proves the handler parses; it does not prove the endpoint works.
 *
 * cloudflared rather than ngrok: the quick tunnel needs no account, no token
 * and no config file, which means this script is the whole setup rather than
 * step four of it. The trade is that the hostname is random and changes on
 * every restart - see the note about APP_URL below.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.resolve(here, "..", ".env"), quiet: true });

/*
 * Read from .env rather than process.env, the way db-urls.mjs does. An
 * exported APP_URL pointing at a previous tunnel would otherwise silently
 * decide which port this forwards to.
 */
const appUrl = process.env["APP_URL"] ?? "http://localhost:3000";

let port;
try {
  port = new URL(appUrl).port || "3000";
} catch {
  console.error(`APP_URL is not a URL: ${appUrl}`);
  process.exit(1);
}

const INSTALL = {
  win32: "winget install --id Cloudflare.cloudflared",
  darwin: "brew install cloudflared",
  linux:
    "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
};

/*
 * No `shell: true`, on any platform. It would work, but Node 22 deprecates
 * passing an argument array alongside it (DEP0190) and prints a warning on
 * every run - noise in a script whose entire output is meant to be read.
 * cloudflared is a real executable on PATH, so plain spawn finds it.
 */
const probe = spawnSync("cloudflared", ["--version"], { stdio: "ignore" });

if (probe.error || probe.status !== 0) {
  console.error(
    [
      "cloudflared is not on PATH.",
      "",
      `  ${INSTALL[process.platform] ?? INSTALL.linux}`,
      "",
      "Then run this again.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  [
    "",
    `Forwarding a public HTTPS origin to http://localhost:${port}.`,
    "",
    "cloudflared prints the hostname below. Two things need it, and both are",
    "easy to forget:",
    "",
    "  1. Set APP_URL in .env to that hostname and restart `npm run dev`.",
    "     Configuration > Numbers builds the webhook URL a tenant pastes into",
    "     Meta out of APP_URL, so leaving it at localhost shows them a URL that",
    "     cannot work - and the page will look perfectly correct while it does.",
    "",
    "  2. Paste <hostname>/api/webhooks/whatsapp/<webhookKey> into the Meta app",
    "     config, with the verify token stored for that integration.",
    "",
    "The hostname changes every restart. Both steps are needed again each time.",
    "",
  ].join("\n"),
);

/*
 * stdio inherited so cloudflared's own hostname banner and request log reach
 * the terminal unchanged - that log is the fastest way to see whether a
 * delivery arrived at all, which is the first question when a webhook appears
 * to do nothing.
 */
const tunnel = spawn(
  "cloudflared",
  ["tunnel", "--url", `http://localhost:${port}`],
  { stdio: "inherit" },
);

tunnel.on("exit", (code) => process.exit(code ?? 0));

/*
 * Forward the signal rather than dying first. Ctrl-C otherwise leaves
 * cloudflared holding the tunnel open with nothing reading its output.
 */
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => tunnel.kill(signal));
}
