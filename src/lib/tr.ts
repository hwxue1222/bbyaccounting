import { useUiStore } from "@/stores/uiStore";

export function useTr() {
  const lang = useUiStore((s) => s.lang);
  return (zh: string, en: string) => (lang === "zh" ? zh : en);
}

