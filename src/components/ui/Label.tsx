import type { LabelHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export default function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className={cn("text-xs font-medium text-zinc-600", className)} />;
}

