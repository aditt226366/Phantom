import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

/**
 * One figure, what it counts, and over what window.
 *
 * The window matters enough to be part of the component rather than optional
 * prose: a number labelled only "API calls" invites the reader to supply their
 * own definition of the period, and they will supply the wrong one.
 *
 * Display face for the figure, at the light weight — never bolded.
 */
export interface StatCardProps {
  label: string;
  value: string;
  /** The window or definition. Rendered small, under the figure. */
  caption?: string;
  /** A qualification the reader needs in order to trust the figure. */
  note?: ReactNode;
}

export function StatCard({ label, value, caption, note }: StatCardProps) {
  return (
    <Card className="flex flex-col gap-xxs">
      <p className="text-caption-uppercase text-muted">{label}</p>
      <p className="font-display text-display-md text-ink">{value}</p>
      {caption ? <p className="text-caption text-muted">{caption}</p> : null}
      {note ? <div className="mt-xxs text-caption text-body">{note}</div> : null}
    </Card>
  );
}
