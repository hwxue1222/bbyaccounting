import { useMemo, useState } from "react";
import { useSearchParams, Navigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

export default function InviteAccept() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const { status, error, acceptInvite } = useAuthStore();
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
          <div className="text-lg font-semibold">接受邀请</div>
          <div className="mt-1 text-sm text-zinc-500">设置密码后将自动加入组织。</div>

          <div className="mt-4 space-y-3">
            <div>
              <label className="text-xs text-zinc-600">新密码</label>
              <input
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                placeholder="至少 8 位"
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
              {status === "loading" ? "处理中..." : "接受并加入"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

