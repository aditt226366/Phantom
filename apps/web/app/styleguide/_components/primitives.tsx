import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Layout furniture for the styleguide itself. Not part of the design system. */

export function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-[calc(var(--wa-nav-height)+16px)] border-t border-hairline py-xxl"
    >
      <header className="mb-xl">
        <h2 className="text-display-md text-ink">{title}</h2>
        {lede ? (
          <p className="mt-sm max-w-2xl text-body-md text-body">{lede}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-base mt-xl font-body text-title-sm text-ink first:mt-0">
      {children}
    </h3>
  );
}

/** Monospace token name. */
export function TokenName({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[12px] leading-[1.4] tracking-normal text-muted">
      {children}
    </code>
  );
}

/** Do / Don't callout. */
export function Rule({
  tone,
  children,
}: {
  tone: "do" | "dont";
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-sm text-body-sm">
      <span
        aria-hidden="true"
        className={cn(
          "mt-[7px] h-[6px] w-[6px] shrink-0 rounded-full",
          tone === "do" ? "bg-success" : "bg-error",
        )}
      />
      <span className="text-body">
        <span className="text-body-strong text-ink">
          {tone === "do" ? "Do" : "Don't"}
        </span>{" "}
        — {children}
      </span>
    </li>
  );
}
