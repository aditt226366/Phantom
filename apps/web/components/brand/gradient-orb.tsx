import { cn } from "@/lib/utils";

/**
 * An atmospheric gradient orb.
 *
 * This is the brand's only "colour" moment, and it is strictly decoration:
 * a blurred radial bloom that sits behind content. Per the design system it
 * must never be a component surface, a button fill or a text colour.
 *
 * Enforced by construction rather than by convention:
 *   - it accepts no children, so it cannot contain content
 *   - it is absolutely positioned and aria-hidden
 *   - pointer-events are off (see .wa-orb in globals.css), so it can never
 *     swallow a click from the element it sits behind
 *
 * Size and position come from the caller via className, since those are
 * layout decisions rather than brand decisions.
 */

export const ORB_TONES = ["mint", "peach", "lavender", "sky", "rose"] as const;

export type OrbTone = (typeof ORB_TONES)[number];

const toneClass: Record<OrbTone, string> = {
  mint: "wa-orb-mint",
  peach: "wa-orb-peach",
  lavender: "wa-orb-lavender",
  sky: "wa-orb-sky",
  rose: "wa-orb-rose",
};

export interface GradientOrbProps {
  tone: OrbTone;
  /** Size and position utilities, e.g. "-left-24 top-0 h-96 w-96". */
  className?: string;
}

export function GradientOrb({ tone, className }: GradientOrbProps) {
  return (
    <div
      aria-hidden="true"
      role="presentation"
      className={cn("wa-orb", toneClass[tone], className)}
    />
  );
}
