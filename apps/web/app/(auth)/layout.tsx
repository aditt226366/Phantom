import type { ReactNode } from "react";
import { GradientOrb } from "@/components/brand/gradient-orb";

/**
 * Auth shell: a centred canvas with atmosphere, no application chrome.
 *
 * Deliberately no nav. A half-rendered shell around a sign-in form suggests
 * there is something behind it to get back to, which for a new visitor there
 * is not.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-dvh overflow-hidden bg-canvas">
      <GradientOrb
        tone="mint"
        className="-left-xxl -top-xxl h-[420px] w-[420px]"
      />
      <GradientOrb
        tone="lavender"
        className="-bottom-xxl -right-xxl h-[380px] w-[380px]"
      />

      <div className="wa-above-orbs mx-auto flex min-h-dvh max-w-container items-center justify-center px-lg py-xxl">
        {children}
      </div>
    </div>
  );
}
