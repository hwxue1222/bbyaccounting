import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export type SearchableSelectOption = {
  value: string;
  label: string;
};

export default function SearchableSelect({
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: {
  value: string;
  options: SearchableSelectOption[];
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [panelPos, setPanelPos] = useState<{
    left: number;
    top: number;
    minWidth: number;
    maxWidth: number;
  } | null>(null);

  const selectedLabel = useMemo(() => {
    if (!value) return "";
    return options.find((o) => o.value === value)?.label || "";
  }, [options, value]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return options;
    return options.filter((o) => o.label.toLowerCase().includes(query));
  }, [options, q]);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const el = rootRef.current;
      const panel = panelRef.current;
      if (!el) return;
      if (el.contains(e.target as any)) return;
      if (panel && panel.contains(e.target as any)) return;
      setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    function update() {
      const btn = buttonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 8));
      const top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 8));
      const minWidth = Math.max(160, r.width);
      const maxWidth = Math.max(160, window.innerWidth - left - 8);
      setPanelPos({ left, top, minWidth, maxWidth });
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        className="flex w-full items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((v) => !v);
          setQ("");
        }}
      >
        <div className={"min-w-0 flex-1 truncate " + (value ? "text-zinc-900" : "text-zinc-500")}>
          {value ? selectedLabel : placeholder}
        </div>
        <ChevronDown className="h-4 w-4 text-zinc-500" />
      </button>

      {open && panelPos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              className="z-[2000] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl"
              style={{
                position: "fixed",
                left: panelPos.left,
                top: panelPos.top,
                minWidth: panelPos.minWidth,
                width: 448,
                maxWidth: panelPos.maxWidth,
              }}
            >
              <div className="border-b border-zinc-100 p-2">
                <input
                  ref={inputRef}
                  className="w-full rounded-md border border-zinc-200 px-2 py-1 text-sm"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={placeholder}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setOpen(false);
                  }}
                />
              </div>
              <div className="max-h-72 overflow-auto py-1">
                <button
                  type="button"
                  className={
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50 " +
                    (!value ? "bg-blue-600 text-white hover:bg-blue-600" : "text-zinc-900")
                  }
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  <div className="w-4">{!value ? <Check className="h-4 w-4" /> : null}</div>
                  <div className="whitespace-normal break-words" title={placeholder}>
                    {placeholder}
                  </div>
                </button>
                {filtered.map((o) => {
                  const isSelected = o.value === value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      className={
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50 " +
                        (isSelected ? "bg-blue-600 text-white hover:bg-blue-600" : "text-zinc-900")
                      }
                      onClick={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                    >
                      <div className="w-4">{isSelected ? <Check className="h-4 w-4" /> : null}</div>
                      <div className="whitespace-normal break-words" title={o.label}>
                        {o.label}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
