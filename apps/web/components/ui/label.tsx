"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

/** Form label. Inter 500 at the 18px list-label step's smaller sibling. */
export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(function Label({ className, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        "font-body text-body-strong text-ink",
        "peer-disabled:cursor-not-allowed peer-disabled:text-muted-soft",
        className,
      )}
      {...props}
    />
  );
});
