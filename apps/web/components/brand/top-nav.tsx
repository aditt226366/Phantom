import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * `top-nav` - canvas background, 64px tall, wordmark left, menu centre,
 * sign-in plus one ink pill right. Exactly one primary action in the bar.
 */

export interface TopNavProps {
  className?: string;
}

const NAV_ITEMS = [
  { label: "Overview", href: "#overview" },
  { label: "Tokens", href: "#colour" },
  { label: "Typography", href: "#typography" },
  { label: "Components", href: "#buttons" },
] as const;

export function TopNav({ className }: TopNavProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-50 w-full border-b border-hairline bg-canvas/85 backdrop-blur-sm",
        className,
      )}
    >
      <nav
        aria-label="Primary"
        className="mx-auto flex h-nav max-w-container items-center justify-between gap-lg px-lg"
      >
        <Link
          href="/"
          className="font-display text-title-md text-ink transition-opacity hover:opacity-70"
        >
          whatsapp-os
        </Link>

        <ul className="hidden items-center gap-lg desktop:flex">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                className="text-nav-link text-body transition-colors hover:text-ink"
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-xs">
          <Button variant="link" size="sm" asChild>
            <a href="/api/health">Health</a>
          </Button>
          <Button size="sm" asChild>
            <Link href="/styleguide">Styleguide</Link>
          </Button>
        </div>
      </nav>
    </header>
  );
}
