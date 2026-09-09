export async function api<T>(
  input: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.json !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(input, {
    ...init,
    headers,
    credentials: "include",
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (res.headers.get("Content-Type")?.includes("application/json")) {
    const data = (await res.json()) as any;
    if (!res.ok || data?.success === false) {
      const msg = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return (data?.data ?? data) as T;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.text()) as any as T;
}

