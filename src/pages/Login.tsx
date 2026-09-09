import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { useUiStore } from "@/stores/uiStore";
import { useTr } from "@/lib/tr";

export default function Login() {
  const { status, error, login, register } = useAuthStore();
  const { lang, setLang } = useUiStore();
  const tr = useTr();
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
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-lg font-semibold">BBY Accounting</div>
                <div className="mt-1 text-sm text-zinc-500">{tr("记账、库存 FIFO、固定资产与报表", "Accounting, FIFO inventory, fixed assets and reports")}</div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-white p-1">
                <div className="grid grid-cols-2 gap-1">
                  <button
                    className={
                      lang === "zh"
                        ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                        : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                    }
                    type="button"
                    onClick={() => setLang("zh")}
                  >
                    中文
                  </button>
                  <button
                    className={
                      lang === "en"
                        ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                        : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                    }
                    type="button"
                    onClick={() => setLang("en")}
                  >
                    EN
                  </button>
                </div>
              </div>
            </div>
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
              {tr("登录", "Sign in")}
            </button>
            <button
              className={
                mode === "register"
                  ? "rounded-md bg-white px-3 py-2 text-sm font-medium shadow"
                  : "rounded-md px-3 py-2 text-sm text-zinc-600"
              }
              onClick={() => setMode("register")}
            >
              {tr("注册", "Sign up")}
            </button>
          </div>

          <div className="space-y-3">
            {backendReady && !backendReady.ok ? (
              <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {tr("后端未就绪", "Backend not ready")}: {backendReady.message || "unknown error"}
                <div className="mt-1 text-xs text-amber-700">
                  {tr(
                    "Vercel 需要配置 `DATABASE_URL`、`JWT_SECRET`，并将 `APP_ORIGIN` 设为当前域名。",
                    "Configure `DATABASE_URL` and `JWT_SECRET` on Vercel, and set `APP_ORIGIN` to your domain.",
                  )}
                </div>
              </div>
            ) : null}
            <div>
              <label className="text-xs text-zinc-600">{tr("邮箱", "Email")}</label>
              <input
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-600">{tr("密码", "Password")}</label>
              <input
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={tr("至少 8 位", "At least 8 characters")}
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </div>

            {mode === "register" ? (
              <>
                <div>
                  <label className="text-xs text-zinc-600">{tr("公司名称", "Company name")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("基准币", "Base currency")}</label>
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
              {status === "loading" ? tr("处理中...", "Working...") : mode === "login" ? tr("登录", "Sign in") : tr("创建公司并注册", "Create company & sign up")}
            </button>
          </div>

          <div className="mt-4 text-xs text-zinc-500">
            {tr("部署到 Vercel 时请配置 `DATABASE_URL` 与 `JWT_SECRET`。", "Configure `DATABASE_URL` and `JWT_SECRET` on Vercel.")}
          </div>
        </div>
      </div>
    </div>
  );
}
