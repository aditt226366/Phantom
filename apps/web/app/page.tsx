import Link from "next/link";
import { GradientOrb } from "@/components/brand/gradient-orb";
import { Button } from "@/components/ui/button";

/**
 * Placeholder landing page.
 *
 * No product features - this exists so the scaffold has a front door and so
 * the design tokens are visible without opening the styleguide.
 */
export default function HomePage() {
  return (
    <main className="relative isolate overflow-hidden">
      {/* Decoration only. Orbs never carry content and never intercept input. */}
      <GradientOrb tone="mint" className="-left-32 -top-24 h-[420px] w-[420px]" />
      <GradientOrb tone="lavender" className="-right-24 top-16 h-[360px] w-[360px]" />
      <GradientOrb tone="peach" className="bottom-0 left-1/3 h-[320px] w-[320px]" />

      <div className="wa-above-orbs mx-auto flex min-h-dvh max-w-container flex-col items-center justify-center px-lg py-section text-center">
        <p className="mb-lg text-caption-uppercase uppercase text-muted">
          Foundation scaffold
        </p>

        <h1 className="max-w-3xl text-display-xl text-ink desktop:text-display-mega">
          whatsapp-os
        </h1>

        <p className="mt-lg max-w-2xl text-body-md text-body">
          Next.js 16 App Router, Prisma and a BullMQ worker, wired together with
          a token layer translated from the ElevenLabs design system. No product
          features yet.
        </p>

        <div className="mt-xl flex flex-wrap items-center justify-center gap-sm">
          <Button asChild>
            <Link href="/styleguide">View the styleguide</Link>
          </Button>
          <Button asChild variant="outline">
            <a href="/api/health">Health check</a>
          </Button>
        </div>
      </div>
    </main>
  );
}
