import { useEffect, useMemo, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { useUiStore } from "@/stores/uiStore";
import { useTr } from "@/lib/tr";
import { api } from "@/lib/api";
import Button from "@/components/ui/Button";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import Input from "@/components/ui/Input";
import Label from "@/components/ui/Label";
import Select from "@/components/ui/Select";
import { Segmented, SegmentedItem } from "@/components/ui/Segmented";

export default function Login() {
  const [params] = useSearchParams();
  const redirect = params.get("redirect") || "/";
  const { status, error, login, register } = useAuthStore();
  const { lang, setLang } = useUiStore();
  const tr = useTr();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("BBY Demo");
  const [industry, setIndustry] = useState("restaurant");
  const [baseCurrency, setBaseCurrency] = useState("SGD");
  const [backendReady, setBackendReady] = useState<null | { ok: boolean; message?: string }>(null);
  const [readyTick, setReadyTick] = useState(0);

  const disabled = useMemo(() => {
    if (status === "loading") return true;
    if (backendReady && !backendReady.ok) return true;
    if (!email.trim() || !password.trim()) return true;
    if (mode === "register" && !orgName.trim()) return true;
    return false;
  }, [status, backendReady, email, password, mode, orgName]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const attempt = async () => {
        try {
          await api("/api/health/db", { timeoutMs: 10_000, cache: "no-store" });
          return { ok: true as const };
        } catch (e: any) {
          const code = typeof (e as any)?.code === "string" ? (e as any).code : null;
          const msg = typeof e?.message === "string" ? e.message : "Backend not reachable";
          return { ok: false as const, code, msg };
        }
      };

      const first = await attempt();
      if (cancelled) return;
      if (first.ok) {
        setBackendReady({ ok: true });
        return;
      }

      if (first.code === "DB_NOT_READY" || first.code === "MIGRATION_BUSY" || first.msg.toLowerCase().includes("db not ready")) {
        setBackendReady({ ok: false, message: tr("系统正在初始化（DB not ready），请稍等 10–30 秒…", "System is starting up (DB not ready). Please wait 10–30s…") });
        try {
          await api("/api/ready", { timeoutMs: 40_000, cache: "no-store" });
        } catch {
          void 0;
        }
        const second = await attempt();
        if (cancelled) return;
        if (second.ok) {
          setBackendReady({ ok: true });
          return;
        }
        setBackendReady({ ok: false, message: second.msg });
        return;
      }

      setBackendReady({ ok: false, message: first.msg });
    })();
    return () => {
      cancelled = true;
    };
  }, [readyTick]);

  if (status === "authed") {
    return <Navigate to={redirect} replace />;
  }

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">BBY Accounting</div>
                <div className="mt-1 text-sm text-zinc-500">{tr("记账、库存 FIFO、固定资产与报表", "Accounting, FIFO inventory, fixed assets and reports")}</div>
              </div>
              <Segmented className="grid-cols-2">
                <SegmentedItem active={lang === "zh"} onClick={() => setLang("zh")}>
                  中文
                </SegmentedItem>
                <SegmentedItem active={lang === "en"} onClick={() => setLang("en")}>
                  EN
                </SegmentedItem>
              </Segmented>
            </div>
          </CardHeader>
          <CardContent>
            <Segmented className="mb-4 grid-cols-2">
              <SegmentedItem active={mode === "login"} onClick={() => setMode("login")}>
                {tr("登录", "Sign in")}
              </SegmentedItem>
              <SegmentedItem active={mode === "register"} onClick={() => setMode("register")}>
                {tr("注册", "Sign up")}
              </SegmentedItem>
            </Segmented>

            <div className="space-y-3">
              {backendReady && !backendReady.ok ? (
                <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {tr("后端未就绪", "Backend not ready")}: {backendReady.message || "unknown error"}
                  {backendReady.message?.toLowerCase().includes("missing") ? (
                    <div className="mt-1 text-xs text-amber-700">
                      {tr(
                        "Vercel 需要配置 `DATABASE_URL`、`JWT_SECRET`，并将 `APP_ORIGIN` 设为当前域名。",
                        "Configure `DATABASE_URL` and `JWT_SECRET` on Vercel, and set `APP_ORIGIN` to your domain.",
                      )}
                    </div>
                  ) : null}
                  <div className="mt-2">
                    <Button variant="secondary" className="w-full" onClick={() => setReadyTick((x) => x + 1)}>
                      {tr("重试", "Retry")}
                    </Button>
                  </div>
                </div>
              ) : null}

              <div>
                <Label>{tr("邮箱", "Email")}</Label>
                <Input className="mt-1" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
              </div>
              <div>
                <Label>{tr("密码", "Password")}</Label>
                <Input
                  className="mt-1"
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
                    <Label>{tr("公司名称", "Company name")}</Label>
                    <Input className="mt-1" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
                  </div>
                  <div>
                    <Label>{tr("行业", "Industry")}</Label>
                    <Select className="mt-1" value={industry} onChange={(e) => setIndustry(e.target.value)}>
                      <option value="restaurant">{tr("餐饮", "Restaurant")}</option>
                      <option value="trading">{tr("贸易", "Trading")}</option>
                      <option value="service">{tr("服务", "Service")}</option>
                    </Select>
                  </div>
                  <div>
                    <Label>{tr("基准币", "Base currency")}</Label>
                    <Input className="mt-1" value={baseCurrency} onChange={(e) => setBaseCurrency(e.target.value.toUpperCase())} maxLength={3} />
                  </div>
                </>
              ) : null}

              {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

              <Button
                variant="primary"
                className="w-full"
                disabled={disabled}
                loading={status === "loading"}
                onClick={async () => {
                  if (mode === "login") {
                    await login(email, password);
                  } else {
                    await register(email, password, orgName, baseCurrency, industry);
                  }
                }}
              >
                {mode === "login" ? tr("登录", "Sign in") : tr("提交注册申请", "Submit sign up request")}
              </Button>

              <div className="pt-1 text-xs text-zinc-500">
                {tr("部署到 Vercel 时请配置 `DATABASE_URL` 与 `JWT_SECRET`。", "Configure `DATABASE_URL` and `JWT_SECRET` on Vercel.")}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
