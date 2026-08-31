/**
 * The client-safe half of bulk messaging.
 *
 * Everything reachable from here must be importable from a "use client"
 * component - the mapping screen renders a live preview from the same
 * variable-filling the send path uses, and the two must not drift.
 *
 * The core barrel dragged @node-rs/argon2 into the browser graph for six
 * commits before a page rendered and the build noticed, which is why this is a
 * subpath and not an addition to `.`.
 */
export {
  buildAudience,
  mappingGaps,
  rejectSentence,
} from "./audience.ts";
export type {
  AudienceRow,
  AudienceReject,
  AudienceResult,
  ColumnMapping,
  RejectReason,
} from "./audience.ts";
export { toCsv, csvRows, safeCsvFilename } from "./csv.ts";
export {
  classifyBulkError,
  describeDuration,
  estimatedDurationMs,
  sendDelayMs,
  tierCapacity,
  tierHeadroom,
} from "./limits.ts";
export type {
  BulkErrorAction,
  TierHeadroom,
  TierKnowledge,
} from "./limits.ts";
