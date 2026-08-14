import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The design system replaces Tailwind's default font-size scale with named
 * type steps (text-display-mega, text-body-md, ...). tailwind-merge cannot
 * know that: by default it would read `text-display-mega` as a *colour*
 * utility, decide it conflicts with `text-ink`, and silently drop one of them.
 *
 * Registering the custom scale keeps `cn("text-display-lg", "text-ink")`
 * intact while still letting a later type step override an earlier one.
 */
const TYPE_STEPS = [
  "display-mega",
  "display-xl",
  "display-lg",
  "display-md",
  "display-sm",
  "title-md",
  "title-sm",
  "body-md",
  "body-strong",
  "body-sm",
  "caption",
  "caption-uppercase",
  "button",
  "nav-link",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TYPE_STEPS] }],
      "font-family": [{ font: ["display", "body"] }],
    },
  },
});

/** Merge conditional class names, resolving Tailwind conflicts last-wins. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
