import { useUiStore } from "@/stores/uiStore";

export async function api<T>(
  input: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  useUiStore.getState().beginNetwork();
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  try {
    const res = await fetch(input, {
      ...init,
      headers,
      credentials: "include",
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    });
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
    useUiStore.getState().endNetwork();
  }
}
