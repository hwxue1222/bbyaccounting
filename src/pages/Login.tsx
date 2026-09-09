import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

export default function Login() {
  const { status, error, login, register } = useAuthStore();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("BBY Demo");
  const [baseCurrency, setBaseCurrency] = useState("SGD");
  const [backendReady, setBackendReady] = useState<null | { ok: boolean; message?: string }>(null);

  const disabled = useMemo(() => {
    if (status === "loading") return true;
    if (!email.trim() || !password.trim()) return true;
    if (mode === "register" && !orgName.trim()) return true;
    return false;
  }, [status, email, password, mode, orgName]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ready", { credentials: "include" });
        const json = (await res.json().catch(() => null)) as any;
        if (cancelled) return;
        if (!res.ok || json?.success === false) {
          const msg = typeof json?.error === "string" ? json.error : `HTTP ${res.status}`;
          setBackendReady({ ok: false, message: msg });
          return;
        }
        setBackendReady({ ok: true });
      } catch (e: any) {
        if (cancelled) return;
        setBackendReady({ ok: false, message: typeof e?.message === "string" ? e.message : "Backend not reachable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "authed") {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="mb-5">
            <div className="text-lg font-semibold">BBY Accounting</div>
            <div className="mt-1 text-sm text-zinc-500">记账、库存 FIFO、固定资产与报表</div>
          </div>

          <div className="mb-4 grid grid-cols-2 rounded-lg bg-zinc-100 p-1">
            <button
              className={
                mode === "login"
                  ? "rounded-md bg-white px-3 py-2 text-sm font-medium shadow"
                  : "rounded-md px-3 py-2 text-sm text-zinc-600"
              }
              onClick={() => setMode("login")}
            >
              登录
            </button>
            <button
              className={
                mode === "register"
                  ? "rounded-md bg-white px-3 py-2 text-sm font-medium shadow"
                  : "rounded-md px-3 py-2 text-sm text-zinc-600"
              }
              onClick={() => setMode("register")}
            >
              注册
            </button>
          </div>

          <div className="space-y-3">
            {backendReady && !backendReady.ok ? (
              <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                后端未就绪：{backendReady.message || "unknown error"}
                <div className="mt-1 text-xs text-amber-700">
                  Vercel 需要配置 `DATABASE_URL`、`JWT_SECRET`，并将 `APP_ORIGIN` 设为当前域名。
                </div>
              </div>
            ) : null}
            <div>
              <label className="text-xs text-zinc-600">邮箱</label>
              <input
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-600">密码</label>
              <input
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 位"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </div>

            {mode === "register" ? (
              <>
                <div>
                  <label className="text-xs text-zinc-600">公司名称</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">本位币</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={baseCurrency}
                    onChange={(e) => setBaseCurrency(e.target.value.toUpperCase())}
                    maxLength={3}
                  />
                </div>
              </>
            ) : null}

            {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

            <button
              className="w-full rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              disabled={disabled}
              onClick={async () => {
                if (mode === "login") {
                  await login(email, password);
                } else {
                  await register(email, password, orgName, baseCurrency);
                }
              }}
            >
              {status === "loading" ? "处理中..." : mode === "login" ? "登录" : "创建公司并注册"}
            </button>
          </div>

          <div className="mt-4 text-xs text-zinc-500">
            部署到 Vercel 时请配置 `DATABASE_URL` 与 `JWT_SECRET`。
          </div>
        </div>
      </div>
    </div>
  );
}
