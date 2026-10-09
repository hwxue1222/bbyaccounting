import { useUiStore } from "@/stores/uiStore";

const responseCache = new Map<string, { ts: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const CACHE_TTL_MS = 60_000;

let warmupInFlight: Promise<void> | null = null;
let lastWarmupAt = 0;

async function warmupBackend(timeoutMs: number): Promise<void> {
  const now = Date.now();
  if (now - lastWarmupAt < 8_000) return;
  if (warmupInFlight) return await warmupInFlight;

  warmupInFlight = (async () => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch("/api/ready", { credentials: "include", cache: "no-store", signal: controller.signal });
      lastWarmupAt = Date.now();
    } finally {
      clearTimeout(id);
      warmupInFlight = null;
    }
  })();

  await warmupInFlight;
}

export class ApiError extends Error {
  code?: string;
  errorId?: string;
  constructor(message: string, code?: string, errorId?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.errorId = errorId;
  }
}

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

  const doRequest = async (allowWarmupRetry: boolean): Promise<T> => {
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
          const code = typeof data?.code === "string" && data.code ? data.code : null;
          const inferredCode =
            code ??
            (typeof msgBase === "string" && msgBase.toLowerCase().includes("db not ready") ? "DB_NOT_READY" : null);

          const internalMatch = /Server internal error \(ID ([0-9a-fA-F-]{36})\)/.exec(msgBase);
          const internalId = internalMatch ? internalMatch[1] : null;
          if (internalId) {
            try {
              const debugRes = await fetch(`/api/debug/errors/${encodeURIComponent(internalId)}`, { credentials: "include" });
              if (debugRes.ok && debugRes.headers.get("Content-Type")?.includes("application/json")) {
                const dbg = (await debugRes.json()) as any;
                const msg = typeof dbg?.data?.error?.message === "string" ? dbg.data.error.message : null;
                const route = typeof dbg?.data?.error?.route === "string" ? dbg.data.error.route : null;
                if (msg) {
                  throw new Error(route ? `${msg} (via ${route}, ID ${internalId})` : `${msg} (ID ${internalId})`);
                }
              }
            } catch (e: any) {
              if (e?.message) throw e;
            }
          }

          const err = new ApiError(errorId ? `${msgBase} (ID ${errorId})` : msgBase, inferredCode ?? undefined, errorId ?? undefined);

          const canWarmupRetry =
            allowWarmupRetry &&
            method === "GET" &&
            typeof err.code === "string" &&
            (err.code === "DB_NOT_READY" || err.code === "MIGRATION_BUSY") &&
            input.startsWith("/api/") &&
            input !== "/api/ready";

          if (canWarmupRetry) {
            try {
              await warmupBackend(40_000);
            } catch {
              throw err;
            }
            return await doRequest(false);
          }

          throw err;
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
    return await doRequest(true);
  }

  const p = doRequest(true)
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
