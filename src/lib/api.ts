import { useUiStore } from "@/stores/uiStore";

export async function api<T>(
  input: string,
  init?: RequestInit & { json?: unknown; timeoutMs?: number },
): Promise<T> {
  useUiStore.getState().beginNetwork();
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const controller = new AbortController();
  if (init?.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const timeoutMs = typeof init?.timeoutMs === "number" && init.timeoutMs > 0 ? init.timeoutMs : 60_000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(input, {
        ...init,
        headers,
        credentials: "include",
        signal: controller.signal,
        body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") {
        throw new Error("请求超时，请重试");
      }
      throw e;
    }
    if (res.headers.get("Content-Type")?.includes("application/json")) {
      const data = (await res.json()) as any;
      if (!res.ok || data?.success === false) {
        const msgBase = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
        const errorId = typeof data?.errorId === "string" && data.errorId ? data.errorId : null;
        throw new Error(errorId ? `${msgBase} (ID ${errorId})` : msgBase);
      }
      return (data?.data ?? data) as T;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.text()) as any as T;
  } finally {
    clearTimeout(timeoutId);
    useUiStore.getState().endNetwork();
  }
}
