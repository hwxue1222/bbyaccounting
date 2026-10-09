import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type Variant = "neutral" | "success" | "warning";

export default function Badge({ variant = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      {...props}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        variant === "neutral" ? "bg-zinc-100 text-zinc-700" : "",
        variant === "success" ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200" : "",
        variant === "warning" ? "bg-amber-50 text-amber-800 ring-1 ring-amber-200" : "",
        className,
      )}
    />
  );
}

