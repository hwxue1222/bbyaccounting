import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export default function EmptyState({
  title,
  description,
  icon,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-200 bg-white p-8 text-center", className)}>
      {icon ? <div className="text-zinc-400">{icon}</div> : null}
      <div className="text-sm font-semibold text-zinc-900">{title}</div>
      {description ? <div className="max-w-md text-sm text-zinc-500">{description}</div> : null}
      {actions ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

