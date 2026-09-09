import { create } from "zustand";

export type Lang = "zh" | "en";

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
}));
