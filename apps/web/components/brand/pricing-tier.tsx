import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * `pricing-tier-card` and its `pricing-tier-featured` inversion.
 *
 * Same geometry either way - 16px radius, 32px padding. The featured tier is
 * distinguished by inverting to the dark surface, not by introducing a colour.
 * That is the whole trick of this palette: emphasis comes from value contrast.
 */

export interface PricingTierProps {
  name: string;
  price: string;
  cadence: string;
  description: string;
  features: readonly string[];
  featured?: boolean;
  className?: string;
}

export function PricingTier({
  name,
  price,
  cadence,
  description,
  features,
  featured = false,
  className,
}: PricingTierProps) {
  return (
    <Card
      variant={featured ? "dark" : "default"}
      padding="lg"
      className={cn("flex flex-col", className)}
    >
      <p
        className={cn(
          "text-caption-uppercase uppercase",
          featured ? "text-on-dark-soft" : "text-muted",
        )}
      >
        {name}
      </p>

      <div className="mt-sm flex items-baseline gap-xxs">
        <span
          className={cn(
            "font-display text-display-md",
            featured ? "text-on-dark" : "text-ink",
          )}
        >
          {price}
        </span>
        <span
          className={cn(
            "text-body-sm",
            featured ? "text-on-dark-soft" : "text-muted",
          )}
        >
          {cadence}
        </span>
      </div>

      <p
        className={cn(
          "mt-sm text-body-sm",
          featured ? "text-on-dark-soft" : "text-body",
        )}
      >
        {description}
      </p>

      <ul className="mt-lg flex flex-1 flex-col gap-sm">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-xs">
            <Check
              aria-hidden="true"
              className={cn(
                "mt-[3px] h-4 w-4 shrink-0",
                featured ? "text-on-dark-soft" : "text-muted",
              )}
            />
            <span
              className={cn(
                "text-body-sm",
                featured ? "text-on-dark" : "text-body",
              )}
            >
              {feature}
            </span>
          </li>
        ))}
      </ul>

      <Button
        variant={featured ? "on-dark" : "outline"}
        className="mt-lg w-full"
      >
        Choose {name}
      </Button>
    </Card>
  );
}
