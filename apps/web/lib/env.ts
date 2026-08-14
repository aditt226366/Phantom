import "server-only";
import { parseEnv, webEnvSchema, type WebEnv } from "@whatsapp-os/core";

/**
 * Server-side environment, validated once at module load.
 *
 * Guarded by `server-only`: importing this from a client component is a build
 * error rather than a leaked secret.
 */
export const env: WebEnv = parseEnv(webEnvSchema, process.env, "web environment");
