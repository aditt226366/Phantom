import { redactKeys } from "@whatsapp-os/core";
import { env } from "./env.ts";

/**
 * A deliberately small structured logger.
 *
 * Container logs are read by machines more often than by people, so each line
 * is a single JSON object. Pulling in pino or winston to achieve that would be
 * three dependencies for twenty lines of code.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type Level = keyof typeof LEVELS;

const threshold = LEVELS[env.LOG_LEVEL];

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;

  /*
   * Everything goes through the redactor, including the message.
   *
   * Not at the call sites: a redactor that has to be remembered is one that
   * gets forgotten, and the call site that forgets is the one handling an
   * error from a provider that just echoed our token back. Doing it here means
   * there is no way to log through this module without it.
   */
  const line = JSON.stringify(
    redactKeys({
      level,
      time: new Date().toISOString(),
      message,
      ...fields,
    }),
  );

  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) =>
    emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) =>
    emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) =>
    emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) =>
    emit("error", message, fields),
};
