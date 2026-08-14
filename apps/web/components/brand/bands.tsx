import { Button } from "@/components/ui/button";
import { GradientOrb } from "@/components/brand/gradient-orb";
import { cn } from "@/lib/utils";

/**
 * The full-width bands: `hero-band`, `cta-band` and `footer`.
 *
 * All three sit on the canvas at 96px section padding. The brand does not use
 * alternating background colours to separate sections - whitespace and the
 * occasional hairline do that work.
 */

/* ------------------------------------------------------------------ */

export interface HeroBandProps {
  eyebrow?: string;
  title: string;
  subtitle: string;
  className?: string;
}

export function HeroBand({
  eyebrow,
  title,
  subtitle,
  className,
}: HeroBandProps) {
  return (
    <section
      className={cn(
        "relative isolate overflow-hidden bg-canvas px-lg py-section",
        className,
      )}
    >
      <GradientOrb
        tone="sky"
        className="-top-16 left-1/4 h-[380px] w-[380px]"
      />
      <GradientOrb
        tone="rose"
        className="-right-10 top-24 h-[300px] w-[300px]"
      />

      <div className="wa-above-orbs mx-auto max-w-container text-center">
        {eyebrow ? (
          <p className="mb-base text-caption-uppercase uppercase text-muted">
            {eyebrow}
          </p>
        ) : null}

        {/* 64px at desktop, stepping down to 32px on mobile per the spec. */}
        <h1 className="mx-auto max-w-4xl text-display-md text-ink tablet:text-display-xl desktop:text-display-mega">
          {title}
        </h1>

        <p className="mx-auto mt-lg max-w-2xl text-body-md text-body">
          {subtitle}
        </p>

        <div className="mt-xl flex flex-wrap items-center justify-center gap-sm">
          <Button>Get started</Button>
          <Button variant="outline">Read the docs</Button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

export interface CtaBandProps {
  title: string;
  className?: string;
}

/** `cta-band` - pre-footer, display-lg headline, a single ink pill. */
export function CtaBand({ title, className }: CtaBandProps) {
  return (
    <section
      className={cn(
        "relative isolate overflow-hidden border-t border-hairline bg-canvas px-lg py-section text-center",
        className,
      )}
    >
      <GradientOrb
        tone="lavender"
        className="bottom-0 left-1/2 h-[300px] w-[420px] -translate-x-1/2"
      />

      <div className="wa-above-orbs mx-auto max-w-container">
        <h2 className="mx-auto max-w-2xl text-display-lg text-ink">{title}</h2>
        <div className="mt-xl">
          <Button>Start building</Button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

const FOOTER_COLUMNS = [
  {
    heading: "Product",
    links: ["Overview", "Styleguide", "Changelog"],
  },
  {
    heading: "Platform",
    links: ["Web app", "Worker", "Queues"],
  },
  {
    heading: "Data",
    links: ["Schema", "Migrations", "Tenancy"],
  },
  {
    heading: "Operations",
    links: ["Health", "Runbook", "Docker"],
  },
  {
    heading: "Legal",
    links: ["Privacy", "Terms", "Security"],
  },
] as const;

/** `footer` - canvas background, 5 columns at desktop, 64x48 padding. */
export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer
      className={cn(
        "border-t border-hairline bg-canvas px-lg py-[64px] desktop:px-xxl",
        className,
      )}
    >
      <div className="mx-auto max-w-container">
        <div className="grid grid-cols-2 gap-xl tablet:grid-cols-3 desktop:grid-cols-5">
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.heading}>
              <p className="text-caption-uppercase uppercase text-muted">
                {column.heading}
              </p>
              <ul className="mt-base flex flex-col gap-xs">
                {column.links.map((link) => (
                  <li key={link}>
                    {/* `footer-link` - body-sm, body colour, ink on hover. */}
                    <span className="cursor-default text-body-sm text-body transition-colors hover:text-ink">
                      {link}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-xxl flex flex-col gap-xs border-t border-hairline pt-lg tablet:flex-row tablet:items-center tablet:justify-between">
          <p className="font-display text-title-md text-ink">whatsapp-os</p>
          <p className="text-caption text-muted">
            Foundation scaffold — no product features yet.
          </p>
        </div>
      </div>
    </footer>
  );
}
