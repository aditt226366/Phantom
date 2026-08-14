import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRootEnv,
  parseEnv,
  workerEnvSchema,
  type WorkerEnv,
} from "@whatsapp-os/core";

/* Must run before parseEnv reads process.env. tsx does not load .env itself. */
loadRootEnv(path.dirname(fileURLToPath(import.meta.url)), 3);

/**
 * Worker environment, validated at boot.
 *
 * A worker that starts with bad configuration silently fails jobs instead of
 * refusing to start, which is much harder to notice. parseEnv exits non-zero
 * on a bad value so the container restarts loudly.
 */
export const env: WorkerEnv = parseEnv(
  workerEnvSchema,
  process.env,
  "worker environment",
);
