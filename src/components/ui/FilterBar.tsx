import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export default function FilterBar({
  left,
  right,
  className,
}: {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm", className)}>
      {left ? <div className="flex flex-wrap items-center gap-2">{left}</div> : <div />}
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

