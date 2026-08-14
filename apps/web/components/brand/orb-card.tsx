import { Card } from "@/components/ui/card";
import { GradientOrb, type OrbTone } from "@/components/brand/gradient-orb";
import { cn } from "@/lib/utils";

/**
 * `gradient-orb-card` - a soft canvas card with an atmospheric bloom behind
 * centred display copy. The extra-soft 24px radius is specific to this card.
 *
 * The orb is a sibling of the content, never a background on the card itself:
 * keeping it a separate absolutely-positioned element is what stops the
 * gradient from becoming a surface, which the system forbids.
 */

export interface OrbCardProps {
  tone: OrbTone;
  title: string;
  description?: string;
  className?: string;
}

export function OrbCard({ tone, title, description, className }: OrbCardProps) {
  return (
    <Card
      variant="soft"
      padding="lg"
      className={cn("isolate min-h-[220px]", className)}
    >
      <GradientOrb
        tone={tone}
        className="left-1/2 top-1/2 h-[260px] w-[260px] -translate-x-1/2 -translate-y-1/2"
      />

      <div className="wa-above-orbs flex h-full flex-col items-center justify-center gap-xs py-xl text-center">
        <p className="font-display text-display-sm text-ink">{title}</p>
        {description ? (
          <p className="max-w-[28ch] text-body-sm text-muted">{description}</p>
        ) : null}
      </div>
    </Card>
  );
}
