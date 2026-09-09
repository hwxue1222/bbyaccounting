import { useMemo, useState } from "react";
import { useSearchParams, Navigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { useUiStore } from "@/stores/uiStore";
import { useTr } from "@/lib/tr";

export default function InviteAccept() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const { status, error, acceptInvite } = useAuthStore();
  const { lang, setLang } = useUiStore();
  const tr = useTr();
  const [password, setPassword] = useState("");

  const disabled = useMemo(() => {
    if (!token) return true;
    if (status === "loading") return true;
    if (password.trim().length < 8) return true;
    return false;
  }, [token, status, password]);

  if (status === "authed") {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-lg font-semibold">{tr("接受邀请", "Accept invite")}</div>
              <div className="mt-1 text-sm text-zinc-500">{tr("设置密码后将自动加入公司。", "Set a password to join the company.")}</div>
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

          <div className="mt-4 space-y-3">
            <div>
              <label className="text-xs text-zinc-600">{tr("新密码", "New password")}</label>
              <input
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                placeholder={tr("至少 8 位", "At least 8 characters")}
              />
            </div>

            {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

            <button
              className="w-full rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              disabled={disabled}
              onClick={async () => {
                await acceptInvite(token, password);
              }}
            >
              {status === "loading" ? tr("处理中...", "Working...") : tr("接受并加入", "Accept and join")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
