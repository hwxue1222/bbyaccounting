import type { HTMLAttributes, TableHTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function TableWrap({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn("overflow-auto rounded-lg border border-zinc-200 bg-white shadow-sm", className)} />;
}

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table {...props} className={cn("w-full text-sm", className)} />;
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} className={cn("sticky top-0 bg-zinc-50/80 text-xs text-zinc-600 backdrop-blur", className)} />;
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...props} className={cn("border-t border-zinc-100 hover:bg-zinc-50", className)} />;
}

export function TH({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...props} className={cn("px-3 py-2 text-left font-medium", className)} />;
}

export function TD({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} className={cn("px-3 py-2", className)} />;
}
