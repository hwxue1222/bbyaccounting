import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export default function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1.5 text-sm" : "px-3 py-2 text-sm",
        variant === "primary" ? "bg-blue-700 text-white hover:bg-blue-800" : "",
        variant === "secondary" ? "border border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50" : "",
        variant === "ghost" ? "text-zinc-700 hover:bg-zinc-100" : "",
        variant === "danger" ? "border border-red-200 bg-red-50 text-red-800 hover:bg-red-100" : "",
        className,
      )}
    >
      {loading ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
      {props.children}
    </button>
  );
}
