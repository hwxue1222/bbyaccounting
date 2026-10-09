import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export default function Switch({ checked, className, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { checked: boolean }) {
  return (
    <button
      {...props}
      type="button"
      disabled={disabled}
      aria-pressed={checked}
      className={cn(
        "relative inline-flex h-6 w-11 items-center rounded-full border border-zinc-200 bg-white transition disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-blue-700 border-blue-700" : "",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 rounded-full bg-white shadow transition",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

