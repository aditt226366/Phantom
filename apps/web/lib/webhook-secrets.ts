import "server-only";
import { resolveCompany, withCompany } from "@whatsapp-os/db";
import { open } from "./integrations/seal.ts";

/**
 * The two secrets the webhook route needs, held briefly and printed nowhere.
 *
 * Verifying a delivery needs WHATSAPP_APP_SECRET, and answering the GET
 * handshake needs WHATSAPP_VERIFY_TOKEN. Both live in the vault, both are
 * company-scoped, and getting either means resolving the webhook key, opening a
 * transaction and decrypting - per request, on the one endpoint Meta can point
 * a burst at (R7).
 *
 * So they are cached. Everything below is about the two ways a cache like this
 * goes wrong: serving a value that has been changed, and leaking a value that
 * should never have been printed.
 */

/* -------------------------------------------------------------------------- *
 * The value
 * -------------------------------------------------------------------------- */

const REDACTED = "[redacted]";

/**
 * A string that refuses to render.
 *
 * The registry already routes key NAMES through redactKeys, so a secret in a
 * logged object is scrubbed by the key it sits under. This covers the other
 * direction: a value that escapes by a route the redactor never sees - a
 * template literal, a JSON.stringify of something holding it, a console.log of
 * the object during a debugging session that then ships.
 *
 * toString, toJSON and the inspect hook all answer [redacted], so every printing
 * path in Node reaches the same answer. reveal() is the only way out, and it is
 * spelled like the deliberate act it is.
 */
export class RedactedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The plaintext. The only route to it, and named so a review notices. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /*
   * console.log and util.inspect ignore toString entirely and walk the object.
   *
   * A `#private` field is already invisible to that walk, so this hook is not
   * what keeps the plaintext out of a log today - measured, by deleting it and
   * watching every assertion still pass. What it does is make the output say
   * so: `[redacted]` instead of `RedactedSecret {}`, which is the difference
   * between a reader knowing a secret was withheld and assuming the object was
   * empty.
   *
   * It is also the line that holds if `#value` ever becomes an ordinary
   * property - a refactor with no obvious connection to logging, which is
   * exactly the kind that reintroduces this.
   *
   * The symbol is looked up rather than imported from node:util, so this module
   * stays importable from anywhere without pulling a Node built-in into a graph
   * that might be bundled.
   */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

export interface WebhookSecrets {
  companyId: string;
  integrationId: string;
  /** For X-Hub-Signature-256. */
  appSecret: RedactedSecret;
  /** For the GET handshake's hub.verify_token. */
  verifyToken: RedactedSecret;
}

/* -------------------------------------------------------------------------- *
 * The cache
 * -------------------------------------------------------------------------- */

/** Entries. Bounded so a flood of unknown keys cannot grow it without limit. */
const MAX_ENTRIES = 256;

/**
 * How long an entry is served for.
 *
 * The TTL is the CROSS-INSTANCE BACKSTOP, not the mechanism, and the difference
 * is worth being exact about because the shorter claim would be false.
 *
 * Explicit eviction reaches one process: the one that handled the save. Every
 * other instance is still holding the old value, and nothing tells it
 * otherwise. Those converge when their entries expire - so the honest statement
 * is "evicted immediately where the change happened, and everywhere else within
 * sixty seconds", not "invalidated on save".
 */
const TTL_MS = 60 * 1_000;

interface Entry {
  secrets: WebhookSecrets;
  expiresAt: number;
}

/*
 * Module scope, which in Next means per server instance and - in development -
 * per hot reload. That is the right lifetime: the cache is an optimisation with
 * a sixty-second horizon, so losing it costs one resolve and one decrypt.
 *
 * Insertion order is the eviction order. A Map iterates in insertion order, so
 * the first key is the oldest and dropping it is the whole LRU: re-reading an
 * entry re-inserts it, which moves it to the end.
 */
const cache = new Map<string, Entry>();

/**
 * Read the secrets for a webhook key, from the cache or from the vault.
 *
 * Null when the key resolves to no company, and the caller must not treat that
 * as an error worth a non-2xx - see P2. Nulls are deliberately NOT cached: a
 * key that does not resolve is either an attacker probing or a tenant who has
 * just rotated, and caching the negative would make the rotation take a minute
 * to start working while doing nothing to slow the attacker down, who is
 * already stopped by the throttle.
 */
export async function getWebhookSecrets(
  webhookKey: string,
): Promise<WebhookSecrets | null> {
  const now = Date.now();
  const hit = cache.get(webhookKey);

  if (hit && hit.expiresAt > now) {
    /* Re-inserting moves it to the end, which is what makes the eviction below
       least-recently-used rather than first-inserted. */
    cache.delete(webhookKey);
    cache.set(webhookKey, hit);
    return hit.secrets;
  }

  if (hit) cache.delete(webhookKey);

  const loaded = await loadFromVault(webhookKey);
  if (!loaded) return null;

  cache.set(webhookKey, { secrets: loaded, expiresAt: now + TTL_MS });

  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }

  return loaded;
}

/**
 * Drop everything cached for a company.
 *
 * Called by the admin actions that change or remove WhatsApp credentials, as
 * their last step beside the revalidatePath they already do. Without it a
 * rotated app secret keeps failing signatures and a disconnected integration
 * keeps verifying them, for up to the TTL - both of which read as "the save did
 * not work".
 *
 * By company rather than by key, because that is what the caller has: the admin
 * panel knows the company and the provider, and the webhook key is a column it
 * never looks at. Scanning is fine at 256 entries and needs no second index to
 * keep in step with this one.
 */
export function evictWebhookSecrets(companyId: string): void {
  for (const [key, entry] of cache) {
    if (entry.secrets.companyId === companyId) cache.delete(key);
  }
}

/** Testing seam. Nothing in the application clears the whole cache. */
export function resetWebhookSecretCache(): void {
  cache.clear();
}

async function loadFromVault(webhookKey: string): Promise<WebhookSecrets | null> {
  /*
   * SECURITY DEFINER, and deliberately not checking deactivated_at - correction
   * C2. A suspended workspace's customers keep messaging it and Meta keeps
   * delivering; refusing here would 404 Meta and burn toward the subscription
   * being disabled. The worker declines instead, and records why.
   */
  const companyId = await resolveCompany("webhook", webhookKey);
  if (!companyId) return null;

  const integration = await withCompany(companyId, (db) =>
    db.integration.findFirst({
      where: { provider: "WHATSAPP_CLOUD" },
      select: {
        id: true,
        secrets: { select: { key: true, ciphertext: true } },
      },
    }),
  );

  if (!integration) return null;

  const byKey = new Map(integration.secrets.map((row) => [row.key, row.ciphertext]));
  const appSecret = byKey.get("WHATSAPP_APP_SECRET");
  const verifyToken = byKey.get("WHATSAPP_VERIFY_TOKEN");

  if (!appSecret || !verifyToken) return null;

  /*
   * Decrypted outside the transaction above, which has already closed. The
   * unseal is CPU work and the scope was holding a pooled connection.
   */
  return {
    companyId,
    integrationId: integration.id,
    appSecret: new RedactedSecret(
      open(companyId, integration.id, "WHATSAPP_APP_SECRET", appSecret),
    ),
    verifyToken: new RedactedSecret(
      open(companyId, integration.id, "WHATSAPP_VERIFY_TOKEN", verifyToken),
    ),
  };
}
