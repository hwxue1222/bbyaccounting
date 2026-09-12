import { Link, useNavigate } from "react-router-dom";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useTr } from "@/lib/tr";
import { useState } from "react";

function Card({ title, desc, to }: { title: string; desc: string; to: string }) {
  return (
    <Link
      to={to}
      className="block rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 hover:shadow"
    >
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-sm text-zinc-500">{desc}</div>
    </Link>
  );
}

export default function Dashboard() {
  const tr = useTr();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [draftInput, setDraftInput] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<null | { draft: any; preview?: any; warnings: string[]; missing: string[] }>(null);
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);

  async function sendTurn(text: string) {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr(null);
    setSuggestion(null);
    setMessages((m) => [...m, { role: "user", text: t }]);
    try {
      const userText = [...messages.filter((x) => x.role === "user").map((x) => x.text), t].join("\n");
      const r = await api<{ suggestion: any }>("/api/assist/journal-suggest", {
        method: "POST",
        json: { text: userText, memo: memo.trim() || undefined },
      });
      setSuggestion(r.suggestion);
      const missing = Array.isArray(r.suggestion?.missing) ? r.suggestion.missing : [];
      const hasPreview = Array.isArray(r.suggestion?.preview?.lines) && r.suggestion.preview.lines.length > 0;
      const assistantText = hasPreview
        ? tr("我已生成分录建议，请在下方确认或继续补充细节。", "I generated a journal suggestion. Review below or add more details.")
        : missing.length
          ? tr(`还需要补充信息：${missing.join("；")}`, `More info needed: ${missing.join("; ")}`)
          : tr("我还没能生成完整分录，你可以继续补充金额/币种/付款方式/用途。", "I couldn't generate a complete journal yet. Add amount/currency/payment method/purpose.");
      setMessages((m) => [...m, { role: "assistant", text: assistantText }]);
    } catch (e: any) {
      const msg = e?.message || "Error";
      setErr(msg);
      setMessages((m) => [...m, { role: "assistant", text: msg }]);
    } finally {
      setBusy(false);
      setDraftInput("");
    }
  }

  return (
    <AppShell title={tr("工作台", "Dashboard")}>
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">{tr("文字生成分录", "Text to Journal")}</div>
              <div className="mt-1 text-sm text-zinc-500">{tr("输入一段话，系统给出分录建议，确认后直接过账。", "Describe a transaction, get a suggested journal, then post.")}</div>
            </div>
            <button
              className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              onClick={() => {
                setErr(null);
                setSuggestion(null);
                setMessages([
                  {
                    role: "assistant",
                    text: tr(
                      "把交易用一句话描述给我。我会通过对话追问必要信息，直到分录可确认过账（不会自动过账）。",
                      "Describe the transaction in one message. I'll ask follow-up questions until the journal is ready to post (won't auto-post).",
                    ),
                  },
                ]);
                setDraftInput("");
                setMemo("");
                setOpen(true);
              }}
              type="button"
            >
              {tr("打开对话框", "Open")}
            </button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card title={tr("分录", "Journals")} desc={tr("手工凭证（借贷平衡）、上传附件、过账", "Manual journals, attachments, posting")} to="/journal" />
          <Card title={tr("库存 FIFO", "Inventory FIFO")} desc={tr("入库/出库联动分录，自动计算出货成本", "Inventory linked to journals with FIFO costing")} to="/inventory" />
          <Card title={tr("固定资产", "Fixed Assets")} desc={tr("新增资产、按期折旧、处置", "Add assets, depreciation, disposal")} to="/fixed-assets" />
          <Card title={tr("报表", "Reports")} desc={tr("资产负债表 / 损益表 / 试算平衡表 / 总账", "Balance Sheet / P&L / Trial Balance / GL")} to="/reports" />
        </div>

        {open ? (
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4">
            <div className="w-full max-w-3xl rounded-xl bg-white p-4 shadow-xl">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">{tr("文字生成分录", "Text to Journal")}</div>
                <button
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm hover:bg-zinc-50"
                  onClick={() => {
                    if (busy) return;
                    setOpen(false);
                  }}
                  type="button"
                >
                  {tr("关闭", "Close")}
                </button>
              </div>

              <div className="mt-3 space-y-3">
                <div>
                  <label className="text-xs text-zinc-600">{tr("备注（可选）", "Memo (optional)")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={memo}
                    onChange={(e) => setMemo(e.target.value)}
                    placeholder={tr("会附加到建议的备注里", "Will be appended to the suggested memo")}
                  />
                </div>

                <div className="rounded-lg border border-zinc-200 bg-white">
                  <div className="max-h-72 space-y-2 overflow-auto p-3 text-sm">
                    {messages.map((m, idx) => (
                      <div key={idx} className={m.role === "user" ? "text-right" : "text-left"}>
                        <div
                          className={
                            m.role === "user"
                              ? "inline-block max-w-[85%] rounded-2xl bg-blue-700 px-3 py-2 text-white"
                              : "inline-block max-w-[85%] rounded-2xl bg-zinc-100 px-3 py-2 text-zinc-900"
                          }
                        >
                          {m.text}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-zinc-200 p-3">
                    <label className="text-xs text-zinc-600">{tr("输入", "Input")}</label>
                    <textarea
                      className="mt-1 h-24 w-full resize-none rounded-md border border-zinc-200 px-3 py-2 text-sm"
                      value={draftInput}
                      onChange={(e) => setDraftInput(e.target.value)}
                      placeholder={tr(
                        `例如：董事为公司用现金购买了一辆车，20000 MYR。\n可补充：用途、是否资本化、预计使用年限、付款方式。`,
                        `Example: Director bought a car for the company, 20000 MYR paid in cash.\nAdd: purpose/capitalize?/useful life/payment method.`,
                      )}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        className="rounded-md bg-green-700 px-3 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
                        disabled={busy || !draftInput.trim()}
                        onClick={() => void sendTurn(draftInput)}
                        type="button"
                      >
                        {tr("发送", "Send")}
                      </button>
                      <div className="text-xs text-zinc-500">
                        {tr("通过对话完善信息；生成建议后需你确认才会过账。", "We refine via chat; posting requires your confirmation.")}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {suggestion?.draft ? (
                    <button
                      className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setErr(null);
                        try {
                          const resp = await api<{ entry: { id: string } }>("/api/journals/post", { method: "POST", json: suggestion.draft });
                          setOpen(false);
                          setDraftInput("");
                          setMemo("");
                          setSuggestion(null);
                          setMessages([]);
                          navigate(`/journal?entryId=${encodeURIComponent(resp.entry.id)}`);
                        } catch (e: any) {
                          setErr(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      type="button"
                    >
                      {tr("确认并过账", "Post")}
                    </button>
                  ) : null}
                </div>

                {err ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div> : null}

                {suggestion?.missing?.length ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    <div className="font-medium">{tr("需要补充设置", "Missing setup")}</div>
                    <div className="mt-1">{suggestion.missing.join("；")}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        className="rounded-md border border-amber-200 bg-white px-3 py-1.5 text-sm hover:bg-amber-100 disabled:opacity-50"
                        disabled={busy}
                        onClick={async () => {
                          const last = messages
                            .slice()
                            .reverse()
                            .find((x) => x.role === "user")?.text;
                          if (last) await sendTurn(last);
                        }}
                        type="button"
                      >
                        {tr("重新生成", "Regenerate")}
                      </button>
                      <button className="rounded-md border border-amber-200 bg-white px-3 py-1.5 text-sm hover:bg-amber-100" onClick={() => navigate("/settings")} type="button">
                        {tr("去设置科目", "Go to settings")}
                      </button>
                      <button className="rounded-md border border-amber-200 bg-white px-3 py-1.5 text-sm hover:bg-amber-100" onClick={() => navigate("/fixed-assets")} type="button">
                        {tr("去新增固定资产", "Add fixed asset")}
                      </button>
                      <button className="rounded-md border border-amber-200 bg-white px-3 py-1.5 text-sm hover:bg-amber-100" onClick={() => navigate("/inventory")} type="button">
                        {tr("去新增库存商品", "Add inventory item")}
                      </button>
                    </div>
                  </div>
                ) : null}

                {suggestion?.warnings?.length ? (
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800">
                    <div className="font-medium">{tr("提示", "Notes")}</div>
                    <div className="mt-1">{suggestion.warnings.join("；")}</div>
                  </div>
                ) : null}

                {suggestion?.preview?.lines ? (
                  <div className="overflow-auto rounded-lg border border-zinc-100">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-50 text-xs text-zinc-600">
                        <tr>
                          <th className="px-3 py-2 text-left">{tr("科目", "Account")}</th>
                          <th className="px-3 py-2 text-left">{tr("摘要", "Desc")}</th>
                          <th className="px-3 py-2 text-right">{tr("借", "Dr")}</th>
                          <th className="px-3 py-2 text-right">{tr("贷", "Cr")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {suggestion.preview.lines.map((l: any, idx: number) => (
                          <tr key={idx} className="border-t border-zinc-100">
                            <td className="px-3 py-2">{`${l.accountCode} ${l.accountName || ""}`}</td>
                            <td className="px-3 py-2">{l.description || ""}</td>
                            <td className="px-3 py-2 text-right">{Number(l.debitTxn || 0).toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{Number(l.creditTxn || 0).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
