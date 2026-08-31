import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * "This workspace is not verified yet" — across the whole shell.
 *
 * Not dismissible, unlike the email-verification banner beside it, and the
 * difference is deliberate. An unverified email is an outstanding task; an
 * unverified workspace is the reason nothing on the screen works. A banner
 * that could be dismissed would let somebody hide the only explanation for
 * every blocked section they then click into.
 *
 * A server component with no state, for the same reason.
 */
export function VerificationBanner({
  /** What the tenant should do next, from the gate's own reason code. */
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-sm rounded-lg border border-hairline-strong",
        "bg-surface-strong px-base py-sm",
        "tablet:flex-row tablet:items-center tablet:justify-between",
        className,
      )}
    >
      <p className="text-body-sm text-body">
        <span className="text-body-strong text-ink">
          This workspace is not verified yet.
        </span>{" "}
        {message}
      </p>

      <Button asChild variant="outline" size="sm" className="shrink-0">
        <Link href="/profile/documents">Documents</Link>
      </Button>
    </div>
  );
}
