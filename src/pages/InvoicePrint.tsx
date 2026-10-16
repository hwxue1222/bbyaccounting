import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useTr } from "@/lib/tr";

type InvoiceRecord = {
  id: string;
  invoiceNo: string;
  issueDate: string;
  currency: string;
  fxRate: number;
  status: string;
  billToName: string;
  memo?: string | null;
  paymentAccountName?: string | null;
  paymentBankName?: string | null;
  paymentBankAddress?: string | null;
  paymentAccountNumber?: string | null;
  paymentSwiftCode?: string | null;
  officialStamp?: string | null;
  totalTxn: string | number;
  lineItems: Array<{ particulars: string; paymentMethod: string; amount: number }>;
};

function formatAmount(input: unknown): string {
  return (Math.round((Number(input) || 0) * 100) / 100).toFixed(2);
}

export default function InvoicePrint() {
  const tr = useTr();
  const navigate = useNavigate();
  const { invoiceId } = useParams();
  const [params] = useSearchParams();
  const [invoice, setInvoice] = useState<InvoiceRecord | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const draftKey = params.get("draftKey");
    if (draftKey) {
      try {
        const raw = window.sessionStorage.getItem(draftKey);
        if (!raw) {
          setErr(tr("未找到预览数据，请返回发票表单重新预览。", "Preview data was not found. Please go back to the invoice form and preview again."));
          setBusy(false);
          return;
        }
        setInvoice(JSON.parse(raw) as InvoiceRecord);
        setBusy(false);
        setErr(null);
        return;
      } catch (e: any) {
        setErr(e?.message || tr("读取预览数据失败。", "Failed to load preview data."));
        setBusy(false);
        return;
      }
    }
    if (!invoiceId) return;
    setBusy(true);
    setErr(null);
    api<{ invoice: InvoiceRecord }>(`/api/invoices/${encodeURIComponent(invoiceId)}`, { cache: "no-store", timeoutMs: 120_000 })
      .then((resp) => setInvoice(resp.invoice || null))
      .catch((e: any) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [invoiceId, params, tr]);

  useEffect(() => {
    if (params.get("autoprint") !== "1") return;
    if (!invoice) return;
    const timer = window.setTimeout(() => window.print(), 350);
    return () => window.clearTimeout(timer);
  }, [params, invoice]);

  const displayRows = useMemo(() => {
    const rows = Array.isArray(invoice?.lineItems) ? invoice!.lineItems.slice(0, 12) : [];
    const minRows = Math.max(3, rows.length);
    while (rows.length < minRows) {
      rows.push({ particulars: "", paymentMethod: "", amount: 0 });
    }
    return rows;
  }, [invoice]);

  const currencyLabel = useMemo(() => {
    const code = String(invoice?.currency || "SGD").toUpperCase();
    return code === "SGD" ? "SGD 新币" : code;
  }, [invoice]);

  if (busy) {
    return <div className="p-8 text-sm text-zinc-500">{tr("加载发票中...", "Loading invoice...")}</div>;
  }

  if (err || !invoice) {
    return (
      <div className="p-8">
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{err || tr("未找到发票", "Invoice not found")}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-6 text-zinc-900 print:bg-white print:p-0">
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          body { background: #fff; }
          .print-hidden { display: none !important; }
          .invoice-sheet { box-shadow: none !important; margin: 0 !important; width: auto !important; min-height: auto !important; }
        }
      `}</style>

      <div className="print-hidden mx-auto mb-4 flex max-w-[210mm] items-center justify-between">
        <div className="text-sm text-zinc-500">{tr("按原 PDF 版式生成，可直接打印或另存为 PDF。", "Generated in the original PDF layout. You can print or save as PDF directly.")}</div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
            onClick={() => navigate(-1)}
            type="button"
          >
            {tr("返回", "Back")}
          </button>
          <button
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
            onClick={() => window.open(`/api/invoices/${encodeURIComponent(invoice.id)}/pdf`, "_blank", "noopener,noreferrer")}
            type="button"
          >
            {tr("下载 PDF", "Download PDF")}
          </button>
          <button className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800" onClick={() => window.print()} type="button">
            {tr("打印预览", "Print")}
          </button>
        </div>
      </div>

      <div className="invoice-sheet mx-auto min-h-[297mm] w-full max-w-[210mm] bg-white px-[16mm] py-[16mm] shadow-xl print:shadow-none">
        <div className="flex items-start justify-between">
          <div className="max-w-[62%] text-[14px] leading-7">
            <div className="font-semibold">Bill to 付款单位: {invoice.billToName || "-"}</div>
          </div>
          <div className="text-right">
            <div className="text-[34px] font-semibold tracking-[0.18em]">INVOICE</div>
            <div className="-mt-1 text-[20px] font-medium tracking-[0.2em]">发票</div>
            <div className="mt-6 text-[14px] leading-7">
              <div>
                <span className="font-semibold">Invoice No.发票编号:</span> {invoice.invoiceNo}
              </div>
              <div>
                <span className="font-semibold">Date 日期:</span> {invoice.issueDate}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 overflow-hidden border border-zinc-900">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-white">
                <th className="border border-zinc-900 px-2 py-2 text-center font-medium">S/N<br />序号</th>
                <th className="border border-zinc-900 px-3 py-2 text-left font-medium">Particulars 收款事项</th>
                <th className="border border-zinc-900 px-3 py-2 text-left font-medium">Payment mode 付款方式<br />Cash / Cheque / Fund Transfer</th>
                <th className="border border-zinc-900 px-3 py-2 text-right font-medium">Amount 金额 ({currencyLabel})</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((item, idx) => (
                <tr key={idx}>
                  <td className="h-12 border border-zinc-900 px-2 py-2 text-center align-top">{idx + 1}.</td>
                  <td className="border border-zinc-900 px-3 py-2 align-top">{item.particulars || "\u00A0"}</td>
                  <td className="border border-zinc-900 px-3 py-2 align-top">{item.paymentMethod || "\u00A0"}</td>
                  <td className="border border-zinc-900 px-3 py-2 text-right align-top">{item.amount > 0 ? formatAmount(item.amount) : "\u00A0"}</td>
                </tr>
              ))}
              <tr>
                <td className="border border-zinc-900 px-2 py-3" colSpan={3}>
                  <div className="text-[13px] font-medium">Payment method 付款信息如下:</div>
                  <div className="mt-2 space-y-1 text-[13px] leading-6">
                    <div>Account name 收款人：{invoice.paymentAccountName || "-"}</div>
                    <div>Bank name 银行名: {invoice.paymentBankName || "-"}</div>
                    <div>Bank address 银行地址: {invoice.paymentBankAddress || "-"}</div>
                    <div>Account number 银行账户: {invoice.paymentAccountNumber || "-"}</div>
                    <div>Swift code 国际汇款号: {invoice.paymentSwiftCode || "-"}</div>
                  </div>
                </td>
                <td className="border border-zinc-900 px-3 py-3 align-bottom">
                  <div className="text-right text-[13px] font-medium">TOTAL 合计 ({currencyLabel})</div>
                  <div className="mt-10 text-right text-[20px] font-semibold">{formatAmount(invoice.totalTxn)}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-10 flex items-end justify-between">
          <div className="max-w-[60%] text-[13px] leading-6 text-zinc-700">
            {invoice.memo ? (
              <>
                <div className="font-medium">{tr("备注", "Memo")}</div>
                <div>{invoice.memo}</div>
              </>
            ) : null}
          </div>
          <div className="w-[220px]">
            <div className="text-right text-[13px]">Official Stamp 公章:</div>
            <div className="mt-3 h-[82px] rounded-sm border border-dashed border-zinc-400">
              {invoice.officialStamp ? <div className="flex h-full items-center justify-center px-4 text-center text-[13px]">{invoice.officialStamp}</div> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
