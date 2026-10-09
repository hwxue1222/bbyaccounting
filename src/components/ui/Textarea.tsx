import type { TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export default function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none ring-blue-200 transition placeholder:text-zinc-400 focus-visible:border-blue-300 focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    />
  );
}
