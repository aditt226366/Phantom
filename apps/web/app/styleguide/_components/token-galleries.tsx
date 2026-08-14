import { isColourToken, type TokenGroup } from "@/lib/tokens";
import { Section, SubHeading, TokenName } from "./primitives";

/**
 * Renders every token parsed out of globals.css.
 *
 * Note on the literal class maps below: Tailwind scans source text for class
 * names, so a template string like `text-${step}` would never be generated.
 * Every utility the styleguide demonstrates has to appear literally in the
 * source, which is why these maps are spelled out rather than derived.
 */

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/* ------------------------------------------------------------------ */

function Swatch({
  name,
  value,
  note,
}: {
  name: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-xs">
      <div
        className="h-20 w-full rounded-lg border border-hairline"
        style={{ backgroundColor: `var(${name})` }}
      />
      <div>
        <p className="text-body-sm text-ink">{name.replace("--wa-", "")}</p>
        <TokenName>{value}</TokenName>
        {note ? (
          <p className="mt-xxs text-caption text-muted">{note}</p>
        ) : null}
      </div>
    </div>
  );
}

export function ColourGallery({ groups }: { groups: TokenGroup[] }) {
  const colourGroups = groups.filter((group) =>
    group.tokens.some(isColourToken),
  );

  return (
    <Section
      id="colour"
      title="Colour"
      lede="Every colour token in the system. There is no saturated brand action colour — the near-black ink pill is the only filled CTA. Green appears once, as semantic-success, and is never clickable."
    >
      {colourGroups.map((group) => (
        <div key={group.index}>
          <SubHeading>
            {group.index}. {group.title}
          </SubHeading>
          <div className="grid grid-cols-2 gap-lg tablet:grid-cols-3 desktop:grid-cols-5">
            {group.tokens.filter(isColourToken).map((token) => (
              <Swatch
                key={token.name}
                name={token.name}
                value={token.value}
                {...(token.note ? { note: token.note } : {})}
              />
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Typography                                                          */
/* ------------------------------------------------------------------ */

interface TypeStep {
  step: string;
  className: string;
  family: "display" | "body";
  use: string;
}

const TYPE_STEPS: readonly TypeStep[] = [
  { step: "display-mega", className: "text-display-mega", family: "display", use: "Homepage hero h1" },
  { step: "display-xl", className: "text-display-xl", family: "display", use: "Subsidiary heroes" },
  { step: "display-lg", className: "text-display-lg", family: "display", use: "Section heads" },
  { step: "display-md", className: "text-display-md", family: "display", use: "Sub-section heads" },
  { step: "display-sm", className: "text-display-sm", family: "display", use: "Card group titles" },
  { step: "title-md", className: "text-title-md", family: "body", use: "Component titles" },
  { step: "title-sm", className: "text-title-sm", family: "body", use: "List labels" },
  { step: "body-md", className: "text-body-md", family: "body", use: "Default body" },
  { step: "body-strong", className: "text-body-strong", family: "body", use: "Emphasised body" },
  { step: "body-sm", className: "text-body-sm", family: "body", use: "Footer body" },
  { step: "caption", className: "text-caption", family: "body", use: "Photo captions" },
  { step: "caption-uppercase", className: "text-caption-uppercase", family: "body", use: "Section labels, badges" },
  { step: "button", className: "text-button", family: "body", use: "CTA pill" },
  { step: "nav-link", className: "text-nav-link", family: "body", use: "Top-nav menu" },
] as const;

export function TypographyGallery({ groups }: { groups: TokenGroup[] }) {
  const typeTokens = new Map(
    groups.flatMap((group) => group.tokens).map((t) => [t.name, t.value]),
  );

  const spec = (step: string) =>
    [
      typeTokens.get(`--wa-text-${step}`),
      typeTokens.get(`--wa-leading-${step}`),
      typeTokens.get(`--wa-tracking-${step}`),
    ]
      .filter(Boolean)
      .join(" / ");

  return (
    <Section
      id="typography"
      title="Typography"
      lede="EB Garamond carries display, Inter carries everything else. Display never bolds — the light weight is the editorial signature."
    >
      <div className="mb-xl rounded-lg border border-hairline bg-surface-card p-lg">
        <p className="text-body-strong text-ink">
          A note on the display weight
        </p>
        <p className="mt-xs max-w-3xl text-body-sm text-body">
          The source design specifies Waldenburg Light at weight 300 and names
          EB Garamond as the open-source substitute. Google Fonts ships EB
          Garamond on a 400–800 axis — there is no 300 cut — so{" "}
          <code className="text-ink">--wa-display-weight</code> is set to 400,
          the lightest available. Requesting 300 would either 400 the request or
          trigger synthetic thinning, neither of which is what the design asks
          for. For a literal 300, swap the display face to Cormorant Garamond
          (which does ship one) in <code className="text-ink">app/layout.tsx</code>{" "}
          and change that one token.
        </p>
      </div>

      <div className="flex flex-col divide-y divide-hairline">
        {TYPE_STEPS.map((entry) => (
          <div
            key={entry.step}
            className="grid grid-cols-1 gap-sm py-lg desktop:grid-cols-[220px_1fr] desktop:gap-xl"
          >
            <div className="flex flex-col gap-xxs">
              <TokenName>{entry.step}</TokenName>
              <p className="text-caption text-muted">{spec(entry.step)}</p>
              <p className="text-caption text-muted-soft">
                {entry.family === "display" ? "EB Garamond" : "Inter"} ·{" "}
                {entry.use}
              </p>
            </div>

            <p
              className={`${entry.className} ${
                entry.family === "display" ? "font-display" : "font-body"
              } overflow-hidden text-ink`}
            >
              Voice is an interface
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Radius                                                              */
/* ------------------------------------------------------------------ */

const RADIUS_STEPS = [
  { step: "none", className: "rounded-none", use: "Reserved" },
  { step: "xs", className: "rounded-xs", use: "Inline tags" },
  { step: "sm", className: "rounded-sm", use: "Compact rows" },
  { step: "md", className: "rounded-md", use: "Form inputs" },
  { step: "lg", className: "rounded-lg", use: "Compact cards" },
  { step: "xl", className: "rounded-xl", use: "Feature cards, pricing tiers" },
  { step: "xxl", className: "rounded-xxl", use: "Gradient orb cards" },
  { step: "pill", className: "rounded-pill", use: "All CTAs and badges" },
  { step: "full", className: "rounded-full", use: "Voice icons, avatars" },
] as const;

export function RadiusGallery({ groups }: { groups: TokenGroup[] }) {
  const values = new Map(
    groups.flatMap((g) => g.tokens).map((t) => [t.name, t.value]),
  );

  return (
    <Section
      id="radius"
      title="Radius"
      lede="Pill geometry for every CTA and badge; 16px for cards. Sharp 0px corners are reserved and never used on an action."
    >
      <div className="grid grid-cols-2 gap-lg tablet:grid-cols-3 desktop:grid-cols-5">
        {RADIUS_STEPS.map((entry) => (
          <div key={entry.step} className="flex flex-col gap-xs">
            <div
              className={`h-20 w-full border border-hairline-strong bg-surface-card ${entry.className}`}
            />
            <div>
              <p className="text-body-sm text-ink">{entry.step}</p>
              <TokenName>
                {values.get(`--wa-radius-${entry.step}`) ?? ""}
              </TokenName>
              <p className="mt-xxs text-caption text-muted">{entry.use}</p>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Spacing                                                             */
/* ------------------------------------------------------------------ */

const SPACING_STEPS = [
  "xxs",
  "xs",
  "sm",
  "base",
  "md",
  "lg",
  "xl",
  "xxl",
  "section",
] as const;

export function SpacingGallery({ groups }: { groups: TokenGroup[] }) {
  const values = new Map(
    groups.flatMap((g) => g.tokens).map((t) => [t.name, t.value]),
  );

  return (
    <Section
      id="spacing"
      title="Spacing"
      lede="A 4px base unit, rising to a 96px section rhythm. Bands are separated by whitespace rather than by background colour."
    >
      <div className="flex flex-col gap-sm">
        {SPACING_STEPS.map((step) => (
          <div key={step} className="flex items-center gap-base">
            <span className="w-20 shrink-0 text-body-sm text-ink">{step}</span>
            <span className="w-16 shrink-0">
              <TokenName>{values.get(`--wa-space-${step}`) ?? ""}</TokenName>
            </span>
            <span
              className="h-4 rounded-xs bg-ink"
              style={{ width: `var(--wa-space-${step})` }}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Elevation                                                           */
/* ------------------------------------------------------------------ */

export function ElevationGallery() {
  return (
    <Section
      id="elevation"
      title="Elevation"
      lede="Hairline plus a single soft drop tier. There is no shadow ramp — atmospheric depth comes from the gradient orbs instead."
    >
      <div className="grid grid-cols-1 gap-lg tablet:grid-cols-3">
        <div className="rounded-xl bg-canvas p-lg">
          <p className="text-body-strong text-ink">Flat</p>
          <p className="mt-xxs text-body-sm text-body">
            Canvas. Body bands and the footer.
          </p>
        </div>
        <div className="rounded-xl border border-hairline bg-surface-card p-lg">
          <p className="text-body-strong text-ink">Card + hairline</p>
          <p className="mt-xxs text-body-sm text-body">
            White surface, 1px hairline outline.
          </p>
        </div>
        <div className="rounded-xl border border-hairline bg-surface-card p-lg shadow-soft-drop">
          <p className="text-body-strong text-ink">Soft drop</p>
          <p className="mt-xxs text-body-sm text-body">
            0 4px 16px rgba(0,0,0,0.04). Hover only.
          </p>
        </div>
      </div>
    </Section>
  );
}
