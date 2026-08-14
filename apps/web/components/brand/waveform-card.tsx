import { Play } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * `audio-waveform-card` - play control, waveform glyph, voice metadata.
 *
 * The bar heights are generated from a fixed deterministic formula rather than
 * Math.random(). A random waveform would differ between the server render and
 * the client hydration and throw a mismatch warning on every mount.
 */

const BAR_COUNT = 44;

/** Deterministic pseudo-waveform: two out-of-phase sines, clamped. */
const BARS: number[] = Array.from({ length: BAR_COUNT }, (_, i) => {
  const envelope = Math.sin((i / BAR_COUNT) * Math.PI);
  const detail = Math.sin(i * 1.7) * 0.35 + Math.sin(i * 0.6) * 0.25;
  return Math.max(0.14, Math.min(1, envelope * (0.72 + detail)));
});

export interface WaveformCardProps {
  name: string;
  meta: string;
  duration: string;
  className?: string;
}

export function WaveformCard({
  name,
  meta,
  duration,
  className,
}: WaveformCardProps) {
  return (
    <Card padding="md" className={cn("", className)}>
      <div className="flex items-center gap-base">
        <button
          type="button"
          aria-label={`Play ${name}`}
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
            "bg-primary text-on-primary transition-colors hover:bg-primary-active",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
          )}
        >
          <Play className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-sm">
            <p className="truncate text-body-strong text-ink">{name}</p>
            <span className="shrink-0 text-caption text-muted">{duration}</span>
          </div>

          {/* Decorative glyph - the real audio state is announced via text. */}
          <div
            aria-hidden="true"
            className="mt-xs flex h-8 items-center gap-[3px]"
          >
            {BARS.map((height, i) => (
              <span
                key={i}
                className="w-[3px] shrink-0 rounded-pill bg-hairline-strong"
                style={{ height: `${Math.round(height * 100)}%` }}
              />
            ))}
          </div>

          <p className="mt-xxs text-caption text-muted">{meta}</p>
        </div>
      </div>
    </Card>
  );
}
