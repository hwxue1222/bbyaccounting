import Button from "@/components/ui/Button";
import { cn } from "@/lib/utils";

export default function Pagination({
  page,
  pageCount,
  onPage,
  className,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  className?: string;
}) {
  const safePageCount = Math.max(1, Math.floor(pageCount || 1));
  const safePage = Math.min(Math.max(1, Math.floor(page || 1)), safePageCount);

  const windowSize = 5;
  const half = Math.floor(windowSize / 2);
  const start = Math.max(1, Math.min(safePage - half, safePageCount - windowSize + 1));
  const end = Math.min(safePageCount, start + windowSize - 1);
  const pages = Array.from({ length: end - start + 1 }, (_, i) => start + i);

  if (safePageCount <= 1) return null;

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2", className)}>
      <div className="text-xs text-zinc-500">
        Page {safePage} / {safePageCount}
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" disabled={safePage <= 1} onClick={() => onPage(1)}>
          First
        </Button>
        <Button size="sm" disabled={safePage <= 1} onClick={() => onPage(safePage - 1)}>
          Prev
        </Button>
        {pages.map((p) => (
          <Button key={p} size="sm" variant={p === safePage ? "primary" : "secondary"} onClick={() => onPage(p)}>
            {p}
          </Button>
        ))}
        <Button size="sm" disabled={safePage >= safePageCount} onClick={() => onPage(safePage + 1)}>
          Next
        </Button>
        <Button size="sm" disabled={safePage >= safePageCount} onClick={() => onPage(safePageCount)}>
          Last
        </Button>
      </div>
    </div>
  );
}

