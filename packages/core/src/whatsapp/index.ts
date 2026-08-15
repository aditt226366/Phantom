/**
 * The client-safe half of the WhatsApp layer.
 *
 * Everything reachable from here must be importable from a "use client"
 * component. The template preview will be one, and it renders from the same
 * module the submission is built from - which is the whole point of decision 10
 * and the reason this barrel exists at all.
 *
 * node:crypto, database access and anything else server-only belongs in
 * @whatsapp-os/core/whatsapp-server. The failure mode is not a compile error:
 * the core barrel dragged @node-rs/argon2 into the browser graph for six
 * commits before a page rendered and the build noticed.
 */
export {
  MESSAGE_STATUSES,
  advanceStatus,
  isRankedStatus,
  statusFromMeta,
  statusRank,
  statusRankSqlCase,
  statusesBelow,
} from "./status.ts";
export type { MessageStatusName } from "./status.ts";
