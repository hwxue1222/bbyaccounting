import type { SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export default function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm outline-none ring-blue-200 transition focus-visible:border-blue-300 focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    />
  );
}
