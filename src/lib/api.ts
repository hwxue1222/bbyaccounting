import { useUiStore } from "@/stores/uiStore";

const responseCache = new Map<string, { ts: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const CACHE_TTL_MS = 15_000;

export async function api<T>(
  input: string,
  init?: RequestInit & { json?: unknown; timeoutMs?: number },
): Promise<T> {
  const method = String(init?.method || "GET").toUpperCase();
  const hasBody = init?.json !== undefined || init?.body !== undefined;
  const cacheable = method === "GET" && !hasBody && init?.cache !== "no-store";
  const cacheKey = `${method} ${input}`;

  if (method !== "GET") {
    responseCache.clear();
  }

  const now = Date.now();
  if (cacheable) {
    const cached = responseCache.get(cacheKey);
    if (cached && now - cached.ts <= CACHE_TTL_MS) {
      return cached.value as T;
    }
    const existing = inflight.get(cacheKey);
    if (existing) {
      return (await existing) as T;
    }
  }

  const doRequest = async (): Promise<T> => {
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
  };

  if (!cacheable) {
    return await doRequest();
  }

  const p = doRequest()
    .then((value) => {
      responseCache.set(cacheKey, { ts: Date.now(), value });
      return value;
    })
    .finally(() => {
      inflight.delete(cacheKey);
    });

  inflight.set(cacheKey, p as unknown as Promise<unknown>);
  return await p;
}
