import { useEffect } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import Button from "@/components/ui/Button";
import { useUiStore } from "@/stores/uiStore";

export type ToastType = "success" | "error" | "info";

export type ToastItem = {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  createdAt: number;
  ttlMs: number;
};

function iconFor(type: ToastType) {
  if (type === "success") return <CheckCircle2 className="h-5 w-5 text-emerald-600" />;
  if (type === "error") return <XCircle className="h-5 w-5 text-red-600" />;
  return <Info className="h-5 w-5 text-blue-600" />;
}

export default function ToastViewport() {
  const toasts = useUiStore((s) => (s as any).toasts as ToastItem[]);
  const dismissToast = useUiStore((s) => (s as any).dismissToast as (id: string) => void);

  useEffect(() => {
    if (!Array.isArray(toasts) || !toasts.length) return;
    const timers = toasts.map((t) => window.setTimeout(() => dismissToast(t.id), Math.max(500, t.ttlMs)));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [toasts, dismissToast]);

  if (!Array.isArray(toasts) || !toasts.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[2100] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "flex items-start gap-3 rounded-xl border bg-white px-4 py-3 shadow-xl",
            t.type === "success" ? "border-emerald-200" : "",
            t.type === "error" ? "border-red-200" : "",
            t.type === "info" ? "border-blue-200" : "",
          )}
        >
          <div className="pt-0.5">{iconFor(t.type)}</div>
          <div className="min-w-0 flex-1">
            {t.title ? <div className="text-sm font-semibold text-zinc-900">{t.title}</div> : null}
            <div className={cn("text-sm", t.title ? "text-zinc-600" : "text-zinc-900")}>{t.message}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

