import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { useUiStore } from "@/stores/uiStore";
import { useTr } from "@/lib/tr";
import Button from "@/components/ui/Button";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import Input from "@/components/ui/Input";
import Label from "@/components/ui/Label";
import { Segmented, SegmentedItem } from "@/components/ui/Segmented";

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
    if (status !== "authed" && password.trim().length < 8) return true;
    return false;
  }, [token, status, password]);

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">{tr("接受邀请", "Accept invite")}</div>
                {status === "authed" ? (
                  <div className="mt-1 text-sm text-zinc-500">{tr("你已登录，点击即可加入公司。", "You are signed in. Click to join the company.")}</div>
                ) : (
                  <div className="mt-1 text-sm text-zinc-500">{tr("新用户请设置密码；已有账号请先登录再加入。", "New users set a password; existing users sign in first.")}</div>
                )}
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
            <div className="space-y-3">
              {status !== "authed" ? (
                <div>
                  <Label>{tr("新密码", "New password")}</Label>
                  <Input className="mt-1" value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder={tr("至少 8 位", "At least 8 characters")} />
                </div>
              ) : null}

              {status !== "authed" ? (
                <div className="text-xs text-zinc-500">
                  {tr("已有账号？", "Already have an account?")}{" "}
                  <Link className="text-blue-700 hover:underline" to={`/login?redirect=${encodeURIComponent(`/auth/invite?token=${token}`)}`}>
                    {tr("去登录", "Sign in")}
                  </Link>
                </div>
              ) : null}

              {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

              <Button
                variant="primary"
                className="w-full"
                disabled={disabled}
                loading={status === "loading"}
                onClick={async () => {
                  await acceptInvite(token, status === "authed" ? "" : password);
                }}
              >
                {tr("接受并加入", "Accept and join")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
