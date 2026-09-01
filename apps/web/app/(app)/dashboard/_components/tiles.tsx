import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { formatCount } from "@/lib/format";
import type { PendingCard } from "@/lib/dashboard/pending";
import { cn } from "@/lib/utils";

/**
 * The small pieces: a figure, a section heading, and the card that admits it
 * has no data.
 */

/**
 * One number, with what it counts under it.
 *
 * The figure runs the display serif at 400 - the editorial signature, never
 * bolded. A dashboard is exactly where the temptation to bold a number is
 * strongest and where it would read most like a consumer analytics product.
 */
export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | string;
  /** A second line: "12 new today", a denominator, a caveat. Optional. */
  detail?: string | undefined;
}) {
  return (
    <Card padding="md" className="flex min-w-0 flex-col gap-xxs">
      <span className="truncate text-caption-uppercase text-muted">{label}</span>
      <span className="font-display text-display-md text-ink">
        {typeof value === "number" ? formatCount(value) : value}
      </span>
      {detail ? (
        <span className="text-caption text-body">{detail}</span>
      ) : null}
    </Card>
  );
}

/**
 * A heading between bands of cards.
 *
 * Sans, not the display face. The page has one display heading - its title -
 * and a second tier in the same face turns a dashboard into a magazine.
 */
export function BandHeading({
  title,
  note,
}: {
  title: string;
  note?: string | undefined;
}) {
  return (
    <div className="mb-base flex flex-col gap-xxs">
      <h2 className="font-body text-title-sm text-ink">{title}</h2>
      {note ? <p className="text-caption text-muted">{note}</p> : null}
    </div>
  );
}

/** A card with a title, an optional aside, and content. */
export function PanelCard({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card padding="md" className={cn("flex min-w-0 flex-col", className)}>
      <div className="mb-base flex items-start justify-between gap-sm">
        <h3 className="font-body text-body-strong text-ink">{title}</h3>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      {children}
    </Card>
  );
}

/**
 * A card for something that does not exist yet.
 *
 * Deliberately the same shape and the same height rhythm as a real card, so the
 * page does not rearrange itself when the data arrives. And deliberately NOT
 * greyed out or dashed: a disabled-looking card reads as a feature that is
 * switched off for this tenant, which is a different and worse thing to imply
 * than "this is not built".
 *
 * The absence of a figure is the whole point. There is no zero anywhere on it,
 * because a zero here would be read as a fact about the business.
 */
export function NotYetCard({ card }: { card: PendingCard }) {
  return (
    <Card padding="md" className="flex min-w-0 flex-col gap-xs">
      <h3 className="font-body text-body-strong text-ink">{card.title}</h3>
      <p className="text-body-sm text-body">{card.description}</p>
      <p className="mt-auto pt-xs text-caption text-muted">
        {card.arrivesWith
          ? `Arrives with ${card.arrivesWith}.`
          : "Not built yet."}
      </p>
    </Card>
  );
}

/**
 * The line that says how old the numbers are.
 *
 * Always rendered, never conditional on the news being bad. A page that shows
 * an age only when something is wrong teaches people that the absence of a line
 * means live - and nothing on the rolled-up half of this page is live.
 */
export function FreshnessLine({
  label,
  notice,
  tone,
}: {
  label: string;
  /** The second sentence, when the counted day is not today's. */
  notice?: string | null;
  tone: "fresh" | "stale" | "never";
}) {
  return (
    <div className="flex flex-col gap-xxs">
      <p
        className={cn(
          "text-caption",
          tone === "stale" ? "text-error" : "text-muted",
        )}
      >
        {label}
      </p>
      {notice ? <p className="text-caption text-error">{notice}</p> : null}
    </div>
  );
}
