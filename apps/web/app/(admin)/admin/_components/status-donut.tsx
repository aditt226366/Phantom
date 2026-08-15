import { Card } from "@/components/ui/card";
import { formatCount } from "@/lib/format";

/**
 * Active against deactivated, as a ring.
 *
 * Inline SVG and no chart dependency: this is two arcs, and a charting library
 * is a large amount of machinery plus its own colour opinions to import into a
 * system whose whole premise is that it has one palette.
 *
 * Colour is near-monochrome by the same rule the rest of the system follows —
 * ink for the live half, a hairline tone for the suspended one. Not green and
 * red: green is reserved for semantic status and is never decorative, and a
 * deactivated workspace is a state rather than an error. Both slices are
 * labelled in the legend, so the chart does not rely on colour alone.
 *
 * currentColor via a text-* class rather than a stroke-* utility, so the value
 * comes from the same token the rest of the page uses.
 */

const SIZE = 120;
const STROKE = 16;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface StatusDonutProps {
  active: number;
  deactivated: number;
}

export function StatusDonut({ active, deactivated }: StatusDonutProps) {
  const total = active + deactivated;

  /*
   * The zero state is the one a fresh deployment is actually in, and the one
   * that divides by zero. Handled first, and by not doing the arithmetic at
   * all rather than by guarding each expression.
   */
  const activeLength = total === 0 ? 0 : (active / total) * CIRCUMFERENCE;

  return (
    <Card className="flex flex-col gap-base">
      <p className="text-caption-uppercase text-muted">Company status</p>

      <div className="flex items-center gap-lg">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={
            total === 0
              ? "No companies yet"
              : `${active} active and ${deactivated} deactivated of ${total} companies`
          }
          className="shrink-0"
        >
          {/* The track. Also the whole ring when there is nothing to show. */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            stroke="currentColor"
            className="text-hairline"
          />

          {total > 0 && active > 0 ? (
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              stroke="currentColor"
              strokeDasharray={`${activeLength} ${CIRCUMFERENCE - activeLength}`}
              /* Start at twelve o'clock rather than three. */
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              className="text-ink"
            />
          ) : null}
        </svg>

        <dl className="flex flex-col gap-xs">
          <Legend
            tone="ink"
            label="Active"
            value={total === 0 ? "—" : formatCount(active)}
          />
          <Legend
            tone="hairline"
            label="Deactivated"
            value={total === 0 ? "—" : formatCount(deactivated)}
          />
        </dl>
      </div>

      {total === 0 ? (
        <p className="text-caption text-muted">
          No companies yet. Companies appear here when someone signs up.
        </p>
      ) : null}
    </Card>
  );
}

function Legend({
  tone,
  label,
  value,
}: {
  tone: "ink" | "hairline";
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-xs">
      <span
        aria-hidden
        className={`size-xs rounded-full ${
          tone === "ink" ? "bg-ink" : "bg-hairline-strong"
        }`}
      />
      <dt className="text-body-sm text-body">{label}</dt>
      <dd className="text-body-strong text-ink">{value}</dd>
    </div>
  );
}
