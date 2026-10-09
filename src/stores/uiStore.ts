import { create } from "zustand";

export type Lang = "zh" | "en";

export type ToastType = "success" | "error" | "info";

export type ToastItem = {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  createdAt: number;
  ttlMs: number;
};

function readInitialLang(): Lang {
  try {
    const v = globalThis.localStorage?.getItem("bby_lang");
    if (v === "zh" || v === "en") return v;
  } catch {
    // ignore
  }
  try {
    const nav = (globalThis.navigator?.language || "").toLowerCase();
    if (nav.startsWith("zh")) return "zh";
  } catch {
    // ignore
  }
  return "zh";
}

type UiState = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  inflight: number;
  inflightStartedAt: number | null;
  beginNetwork: () => void;
  endNetwork: () => void;
  toasts: ToastItem[];
  toast: (t: { type: ToastType; message: string; title?: string; ttlMs?: number }) => void;
  dismissToast: (id: string) => void;
};

export const useUiStore = create<UiState>((set, get) => ({
  lang: readInitialLang(),
  setLang: (lang) => {
    set({ lang });
    try {
      globalThis.localStorage?.setItem("bby_lang", lang);
    } catch {
      // ignore
    }
  },
  toggleLang: () => {
    const next: Lang = get().lang === "zh" ? "en" : "zh";
    get().setLang(next);
  },
  inflight: 0,
  inflightStartedAt: null,
  beginNetwork: () => {
    const cur = get().inflight;
    if (cur <= 0) {
      set({ inflight: 1, inflightStartedAt: Date.now() });
      return;
    }
    set({ inflight: cur + 1 });
  },
  endNetwork: () => {
    const cur = get().inflight;
    const next = Math.max(0, cur - 1);
    set({ inflight: next, inflightStartedAt: next === 0 ? null : get().inflightStartedAt });
  },
  toasts: [],
  toast: (t) => {
    const id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    const item: ToastItem = {
      id,
      type: t.type,
      title: t.title,
      message: t.message,
      createdAt: Date.now(),
      ttlMs: typeof t.ttlMs === "number" && t.ttlMs > 0 ? t.ttlMs : 4000,
    };
    set({ toasts: [...get().toasts, item].slice(-4) });
  },
  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((x) => x.id !== id) });
  },
}));
