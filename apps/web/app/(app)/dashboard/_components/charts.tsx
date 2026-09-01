import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The dashboard's three charts, as inline SVG.
 *
 * ---------------------------------------------------------------------------
 * No charting library, and that is not austerity
 * ---------------------------------------------------------------------------
 *
 * Every charting library ships its own palette, its own type scale and its own
 * radii, and adopting one means either accepting those - which is a second
 * design system inside a page built on tokens - or overriding every one of them,
 * which is more code than the twenty lines of SVG below. Rule 7 makes the choice
 * for us: a library that emits `#3b82f6` cannot be made to stop.
 *
 * These are also not interactive. A donut with tooltips has to be a client
 * component, which puts a bundle on the one page people leave open all day, to
 * reveal numbers that are already printed in the legend beside it.
 *
 * ---------------------------------------------------------------------------
 * On the numbers inside the SVG
 * ---------------------------------------------------------------------------
 *
 * The geometry is in viewBox user units, not CSS pixels - `r={15.9155}` is a
 * radius chosen so the circumference is 100 and a percentage can be written
 * straight into `stroke-dasharray`. Rule 7 is about design values: colour, type,
 * radius, spacing. Coordinate space inside a viewBox is none of those, it scales
 * with the element, and there is no token that could express it.
 *
 * Colour is `currentColor` throughout, set by a `text-*` utility on the element.
 * That keeps every fill on a --wa-* token without needing `fill-*` utilities,
 * and it means a segment's colour is chosen with the same vocabulary as the
 * legend text beside it.
 */

/**
 * The value ramp, darkest first.
 *
 * A monochrome ramp rather than a categorical palette, because this system does
 * not have one and inventing five hues would be inventing a second design
 * language for one page. It also happens to be the right encoding here: every
 * chart on this page is ordered - a delivery ladder, a set of sources by size -
 * so darkness reading as "more" or "further along" is meaning rather than
 * decoration.
 *
 * The ORDER is chosen for separation, not for the order the tokens are declared
 * in, and that was found by looking at the rendered page rather than by
 * reasoning about it. `ink` (#0c0a09) and `body-strong` (#292524) are adjacent
 * in the type scale and all but identical as fills: the source donut has two
 * segments, they came out as one solid ring, and the chart said nothing at all.
 *
 * So the ramp steps in visible increments - #0c0a09, #4e4e4e, #777169, #a8a29e,
 * #d6d3d1 - and `body-strong` sits last, where a sixth segment is already an
 * unusual chart. Adjacent steps must be distinguishable side by side, which is
 * a stronger requirement than being distinguishable in a paragraph.
 *
 * Written as full literal class names because Tailwind's scanner reads source
 * text. A class assembled from a variable resolves to nothing and disappears
 * from the stylesheet with no error anywhere.
 */
const RAMP = [
  "text-ink",
  "text-body",
  "text-muted",
  "text-muted-soft",
  "text-hairline-strong",
  "text-body-strong",
] as const;

export function rampTone(index: number): string {
  return RAMP[index % RAMP.length] ?? "text-ink";
}

export interface Segment {
  key: string;
  label: string;
  value: number;
  /** A `text-*` utility. Defaults to the ramp position. */
  tone?: string;
}

/* ------------------------------------------------------------------------- *
   Donut
   ------------------------------------------------------------------------- */

/**
 * A ring, with the total in the middle and a legend beside it.
 *
 * Segments are drawn as arcs of one circle using `stroke-dasharray`, each
 * offset by the run of everything before it. The alternative - a `<path>` per
 * slice with trigonometry - is more code and has a genuine failure mode this
 * does not: a single segment covering 100% is a full circle, which an arc path
 * cannot express because its start and end points coincide.
 */
export function Donut({
  segments,
  caption,
}: {
  segments: readonly Segment[];
  caption?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  if (total <= 0) return null;

  /*
   * The arcs are laid out here rather than by accumulating inside the map.
   *
   * Each segment's dash offset depends on the run of everything before it,
   * which is a fold - and folding with a mutable counter inside a render
   * callback is what react-hooks/immutability refuses, correctly: the callback
   * is not guaranteed to run once per element per render, so a variable
   * carried across it can produce a different chart on a re-render than on the
   * first pass. Computing the layout up front makes the map a pure projection.
   */
  const arcs: Array<{ segment: Segment; percent: number; offset: number }> = [];
  let consumed = 0;

  for (const segment of segments) {
    const percent = (segment.value / total) * 100;
    /*
     * 25 rotates the start to twelve o'clock. Without it the first segment
     * begins at three, which reads as though the chart has been turned rather
     * than as a starting point.
     */
    arcs.push({ segment, percent, offset: 25 - consumed });
    consumed += percent;
  }

  return (
    <div className="flex flex-col gap-lg tablet:flex-row tablet:items-center">
      <svg
        viewBox="0 0 42 42"
        className="h-[160px] w-[160px] shrink-0"
        role="img"
        aria-label={`${formatCount(total)} in total, split by ${segments.length} sources`}
      >
        {/* The track, so a rounding gap reads as part of the ring. */}
        <circle
          cx="21"
          cy="21"
          r="15.9155"
          fill="none"
          strokeWidth="5"
          className="text-hairline-soft"
          stroke="currentColor"
        />

        {arcs.map(({ segment, percent, offset }, index) => (
          <circle
            key={segment.key}
            cx="21"
            cy="21"
            r="15.9155"
            fill="none"
            strokeWidth="5"
            stroke="currentColor"
            strokeDasharray={`${percent} ${100 - percent}`}
            strokeDashoffset={offset}
            className={segment.tone ?? rampTone(index)}
          />
        ))}

        <text
          x="21"
          y="21"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-ink font-body text-[5px]"
        >
          {formatCount(total)}
        </text>
      </svg>

      <ul className="flex min-w-0 flex-1 flex-col gap-xs">
        {segments.map((segment, index) => (
          <li key={segment.key} className="flex items-center gap-xs">
            <span
              aria-hidden
              className={cn(
                "size-[10px] shrink-0 rounded-full bg-current",
                segment.tone ?? rampTone(index),
              )}
            />
            <span className="min-w-0 flex-1 truncate text-body-sm text-body">
              {segment.label}
            </span>
            <span className="text-body-sm text-ink">
              {formatCount(segment.value)}
            </span>
          </li>
        ))}
        {caption ? (
          <li className="mt-xxs text-caption text-muted">{caption}</li>
        ) : null}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
   Rate bars
   ------------------------------------------------------------------------- */

export interface RateRow {
  key: string;
  label: string;
  /** Null when there is no denominator. Rendered as an absence, not a zero. */
  percent: number | null;
  /** The two numbers the percentage came from, printed beside it. */
  detail: string;
}

/**
 * Three rates, each as a track and a fill.
 *
 * A null percentage draws no bar and says so in words. That is the whole reason
 * `rate()` returns null rather than zero: a bar drawn at zero is a claim that
 * nothing was delivered, and "nothing has been sent yet" is a different fact
 * that happens to produce the same pixel.
 */
export function RateBars({ rows }: { rows: readonly RateRow[] }) {
  return (
    <ul className="flex flex-col gap-base">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-col gap-xxs">
          <div className="flex items-baseline justify-between gap-sm">
            <span className="text-body-sm text-body-strong">{row.label}</span>
            <span className="text-body-sm text-ink">
              {row.percent === null ? "—" : `${Math.round(row.percent)}%`}
            </span>
          </div>

          <div
            className="h-xxs w-full overflow-hidden rounded-pill bg-hairline-soft"
            role="img"
            aria-label={
              row.percent === null
                ? `${row.label}: nothing to measure yet`
                : `${row.label}: ${Math.round(row.percent)} percent`
            }
          >
            {row.percent === null ? null : (
              <div
                className="h-full rounded-pill bg-ink"
                /*
                 * The one inline style on the page, and it carries a computed
                 * percentage rather than a design value. There is no token for
                 * "however wide this number is", and a Tailwind class built from
                 * a variable is invisible to the scanner and resolves to
                 * nothing at all.
                 */
                style={{ width: `${Math.max(0, Math.min(100, row.percent))}%` }}
              />
            )}
          </div>

          <span className="text-caption text-muted">{row.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------- *
   Ladder bar
   ------------------------------------------------------------------------- */

/**
 * One bar partitioning every outbound message by where it got to.
 *
 * A single stacked bar rather than seven separate ones, because the claim being
 * made is that these account for everything sent - and a set of bars invites
 * reading each against its own scale. The database enforces the same claim:
 * `dashboard_rollups_ladder_partitions_outbound` refuses a row whose parts do
 * not sum to the whole.
 *
 * Segments under half a percent still render at a minimum width, because a
 * failure count of three in ten thousand is exactly the thing somebody needs to
 * see, and it would otherwise be a sub-pixel nobody can click or read.
 */
export function LadderBar({ segments }: { segments: readonly Segment[] }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  if (total <= 0) return null;

  return (
    <div className="flex flex-col gap-sm">
      <div className="flex h-sm w-full overflow-hidden rounded-pill">
        {segments.map((segment, index) => (
          <div
            key={segment.key}
            className={cn("h-full bg-current", segment.tone ?? rampTone(index))}
            style={{
              width: `${Math.max(1.5, (segment.value / total) * 100)}%`,
            }}
            title={`${segment.label}: ${formatCount(segment.value)}`}
          />
        ))}
      </div>

      <ul className="flex flex-wrap gap-x-base gap-y-xxs">
        {segments.map((segment, index) => (
          <li key={segment.key} className="flex items-center gap-xxs">
            <span
              aria-hidden
              className={cn(
                "size-[10px] shrink-0 rounded-full bg-current",
                segment.tone ?? rampTone(index),
              )}
            />
            <span className="text-caption text-body">{segment.label}</span>
            <span className="text-caption text-ink">
              {formatCount(segment.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
