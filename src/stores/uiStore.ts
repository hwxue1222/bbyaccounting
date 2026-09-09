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
}));

