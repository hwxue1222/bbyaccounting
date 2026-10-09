import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Segmented({ className, ...props }: { className?: string; children: any }) {
  return (
    <div className={cn("grid gap-1 rounded-xl border border-zinc-200 bg-white p-1", className)} {...props} />
  );
}

export function SegmentedItem({ active, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "rounded-lg px-3 py-2 text-sm transition",
        active ? "bg-blue-50 font-medium text-blue-700" : "text-zinc-700 hover:bg-zinc-100",
        className,
      )}
    />
  );
}

