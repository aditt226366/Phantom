import Link from "next/link";
import type { FeatureBlock } from "@whatsapp-os/core/kyc";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { blockedCopy } from "@/lib/kyc-display";

/**
 * What a feature section renders while the workspace is unverified.
 *
 * A designed state, not a redirect and not a blank page. A redirect to
 * /profile/documents would be the obvious implementation and is worse in two
 * ways: it loses the fact that the tenant was trying to reach the inbox, and
 * a section they can never reach silently becomes a section that bounces -
 * which reads as a broken link rather than as a requirement.
 *
 * Three things on screen, because a blocked page that only names its state
 * sends the reader to support: what is missing, what to do about it, and where
 * the status lives.
 *
 * The section name is included so the page says what it is refusing. "Verify
 * your business to continue" alone leaves somebody who clicked Billing
 * wondering whether they clicked the wrong thing.
 */
export function FeatureBlocked({
  reason,
  section,
}: {
  reason: FeatureBlock;
  section: string;
}) {
  const copy = blockedCopy(reason);

  return (
    <EmptyState
      tone="lavender"
      title={copy.title}
      description={`${section} is not available yet. ${copy.description}`}
      action={
        copy.showDocumentsLink ? (
          <Button asChild>
            <Link href="/profile/documents">Go to Documents</Link>
          </Button>
        ) : undefined
      }
    />
  );
}
