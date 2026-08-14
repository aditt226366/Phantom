import * as React from "react";
import { GradientOrb, type OrbTone } from "@/components/brand/gradient-orb";
import { cn } from "@/lib/utils";

/**
 * What a section shows before it has anything to show.
 *
 * Deliberately a designed state and not a spinner: every section of the shell
 * lands empty first, and "loading forever" is the wrong story to tell about a
 * feature that simply has no data yet. The copy is the work — each caller
 * passes its own, saying what the section will hold and what to do next.
 *
 * The orb is atmosphere: aria-hidden, pointer-events-none, behind the content.
 * It never contains anything and is never a surface.
 */
export interface EmptyStateProps {
  title: string;
  description: string;
  /** A CTA, usually a single ink pill. Omitted when there is nothing to do yet. */
  action?: React.ReactNode;
  tone?: OrbTone;
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  tone = "mint",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "relative isolate overflow-hidden rounded-xl border border-hairline",
        "bg-surface-card px-lg py-xxl text-center",
        className,
      )}
    >
      <GradientOrb
        tone={tone}
        className="-top-xxl left-1/2 h-[240px] w-[240px] -translate-x-1/2"
      />

      <div className="wa-above-orbs mx-auto flex max-w-md flex-col items-center gap-sm">
        <h2 className="text-display-sm text-ink">{title}</h2>
        <p className="text-body-sm text-body">{description}</p>
        {action ? <div className="mt-xs">{action}</div> : null}
      </div>
    </div>
  );
}
