import type { ReactNode } from "react";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import Button from "@/components/ui/Button";

export default function Modal({
  open,
  title,
  onClose,
  children,
  widthClassName,
}: {
  open: boolean;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  widthClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const el = panelRef.current;
      if (!el) return;
      const focusable = el.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      focusable?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[2000]">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[1px]" onClick={onClose} />
      <div className="absolute inset-0 flex items-start justify-center p-4">
        <div
          ref={panelRef}
          className={cn(
            "w-full rounded-2xl border border-zinc-200 bg-white shadow-2xl",
            widthClassName || "max-w-3xl",
          )}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
            <div className="min-w-0 truncate text-sm font-semibold">{title}</div>
            <Button size="sm" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="p-4">{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
