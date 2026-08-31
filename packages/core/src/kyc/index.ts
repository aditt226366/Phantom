/**
 * The client-safe half of the KYC layer.
 *
 * Everything reachable from here must be importable from a "use client"
 * component - the documents page renders status chips from the same vocabulary
 * the gate decides on, and the two must not drift.
 *
 * node:crypto and anything else server-only belongs in ./upload.ts, which is
 * exported separately. The failure mode is not a compile error: the core
 * barrel dragged @node-rs/argon2 into the browser graph for six commits before
 * a page rendered and the build noticed.
 */
export {
  KYC_KINDS,
  canUseFeatures,
  featuresBlocked,
} from "./policy.ts";
export type {
  KycKind,
  KycStatus,
  KycStatuses,
  FeatureAccess,
  FeatureBlock,
  FeatureFacts,
} from "./policy.ts";
