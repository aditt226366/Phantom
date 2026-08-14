import type { LucideIcon } from "lucide-react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The three plain content cards from the design doc:
 *   feature-card        - 2-up / 3-up benefit grids
 *   testimonial-card    - quote, body-coloured text, 32px padding
 *   product-card-stack  - preview card whose children reach the card edge
 */

/* ------------------------------------------------------------------ */

export interface FeatureCardProps {
  icon?: LucideIcon;
  title: string;
  description: string;
  className?: string;
}

export function FeatureCard({
  icon: Icon,
  title,
  description,
  className,
}: FeatureCardProps) {
  return (
    <Card interactive padding="md" className={cn("h-full", className)}>
      {Icon ? (
        <span className="mb-base flex h-10 w-10 items-center justify-center rounded-full bg-surface-strong">
          <Icon className="h-[18px] w-[18px] text-ink" aria-hidden="true" />
        </span>
      ) : null}

      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="text-body-sm">{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export interface TestimonialCardProps {
  quote: string;
  author: string;
  role: string;
  className?: string;
}

export function TestimonialCard({
  quote,
  author,
  role,
  className,
}: TestimonialCardProps) {
  return (
    <Card padding="lg" className={cn("h-full", className)}>
      <figure className="flex h-full flex-col justify-between gap-lg">
        {/* Display serif at the small step - a pull quote, still never bold. */}
        <blockquote className="font-display text-display-sm text-ink">
          &ldquo;{quote}&rdquo;
        </blockquote>

        <figcaption className="text-body-sm text-body">
          <span className="block text-body-strong text-ink">{author}</span>
          <span className="text-muted">{role}</span>
        </figcaption>
      </figure>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export interface ProductCardStackProps {
  label: string;
  title: string;
  rows: readonly string[];
  className?: string;
}

/**
 * `product-card-stack` - padding 0 on the card, so the header band and the
 * rows below it run edge to edge and the hairlines reach both sides.
 */
export function ProductCardStack({
  label,
  title,
  rows,
  className,
}: ProductCardStackProps) {
  return (
    <Card variant="flush" padding="none" className={cn("h-full", className)}>
      <div className="border-b border-hairline bg-surface-strong px-lg py-base">
        <p className="text-caption-uppercase uppercase text-muted">{label}</p>
        <p className="mt-xxs text-title-md text-ink">{title}</p>
      </div>

      <ul>
        {rows.map((row) => (
          <li
            key={row}
            className="border-b border-hairline-soft px-lg py-sm text-body-sm text-body last:border-b-0"
          >
            {row}
          </li>
        ))}
      </ul>
    </Card>
  );
}
