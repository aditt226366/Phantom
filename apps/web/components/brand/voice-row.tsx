import { Play } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * `voice-row` - transparent row, hairline divider, 32px circular icon left,
 * name plus accent stacked, optional preview control right.
 *
 * The row is 12px padded top and bottom around a 32px icon, which gives the
 * ~48px effective tap target the responsive spec calls for even though the
 * icon itself is smaller.
 */

export interface VoiceRowProps {
  name: string;
  accent: string;
  initials: string;
  className?: string;
}

export function VoiceRow({ name, accent, initials, className }: VoiceRowProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-sm border-b border-hairline py-sm last:border-b-0",
        className,
      )}
    >
      <Avatar>
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <p className="truncate text-body-md text-ink">{name}</p>
        <p className="truncate text-caption text-muted">{accent}</p>
      </div>

      <button
        type="button"
        aria-label={`Preview ${name}`}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          "text-ink transition-colors hover:bg-surface-strong",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        )}
      >
        <Play className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
