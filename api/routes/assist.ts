import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";

const router = Router();

function requireOrgId(req: AuthedRequest, res: Response): string | null {
  const orgId = req.auth!.orgId;
  if (!orgId) {
    res.status(400).json({ success: false, error: "No active organization" });
    return null;
  }
  return orgId;
}

function detectLang(text: string): "zh" | "en" {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}

function pickBestAccountCode(accounts: any[], opts: { type?: string; keywords: string[] }): string | null {
  const kw = opts.keywords.map((s) => s.toLowerCase()).filter(Boolean);
  const filtered = accounts.filter((a) => (opts.type ? String(a.type) === opts.type : true));
  const scored = filtered
    .map((a) => {
      const name = String(a.name || "").toLowerCase();
      const code = String(a.code || "");
      const hit = kw.reduce((s, k) => (name.includes(k) ? s + 1 : s), 0);
      return { code, hit };
    })
    .filter((x) => x.code && x.hit > 0)
    .sort((a, b) => b.hit - a.hit);
  return scored[0]?.code || null;
}

function parseFirstAmountAndCurrency(text: string): { amount: number | null; currency: string | null } {
  const t = String(text || "");
  const m = t.match(/(\d+(?:\.\d+)?)\s*([A-Za-z]{3})/);
  if (!m) return { amount: null, currency: null };
  const amount = Number(m[1]);
  const currency = String(m[2] || "").toUpperCase().slice(0, 3);
  return { amount: Number.isFinite(amount) && amount > 0 ? amount : null, currency: currency || null };
}

function buildHeuristicSuggestion(input: {
  text: string;
  lang: "zh" | "en";
  baseCurrency: string;
  forcedEntryDate: string;
  extraMemo: string;
  accounts: any[];
  accountIdByCode: Map<string, string>;
  accountNameByCode: Map<string, string>;
}): { draft: any; preview: any; warnings: string[]; missing: string[] } {
  const t = (zh: string, en: string) => (input.lang === "zh" ? zh : en);
  const warnings: string[] = [t("已启用免费规则引擎（无需外部 AI）。", "Using free rule-based engine (no external AI).")];
  const missing: string[] = [];

  const { amount, currency } = parseFirstAmountAndCurrency(input.text);
  const ccy = currency || input.baseCurrency;
  if (!amount) missing.push(t("缺少金额（例如：20000 MYR）", "Missing amount (e.g., 20000 MYR)"));
  if (!currency) warnings.push(t(`未明确币种，默认使用 ${input.baseCurrency}`, `Currency not specified; defaulting to ${input.baseCurrency}`));

  const lower = input.text.toLowerCase();
  const isVehicle = /\bcar\b|vehicle|\u6c7d\u8f66|\u8f66\u8f86|\u8f66/.test(lower);
  const payByCash = /cash|\u73b0\u91d1/.test(lower);
  const payByBank = /transfer|bank|\u94f6\u884c|\u8f6c\u8d26/.test(lower);
  const hasDirector = /director|\u8463\u4e8b/.test(lower);
  const hasCompany = /company|\u516c\u53f8/.test(lower);

  let debitCode: string | null = null;
  if (isVehicle) {
    debitCode =
      pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u8f66", "\u6c7d\u8f66", "\u4ea4\u901a", "vehicle", "car", "motor"] }) ||
      pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u56fa\u5b9a\u8d44\u4ea7", "ppe", "property", "plant", "equipment"] });
    if (!debitCode) missing.push(t("缺少固定资产科目（车辆/PPE）", "Missing PPE account (vehicle)") );
  }

  if (!debitCode) {
    debitCode = pickBestAccountCode(input.accounts, { type: "expense", keywords: ["\u8d2d\u4e70", "\u8d39\u7528", "expense"] });
    if (!debitCode) missing.push(t("缺少费用或资产科目用于借方", "Missing debit account (expense/asset)") );
  }

  let creditCode: string | null = null;
  const useDueToDirector = hasDirector && hasCompany && !(lower.includes("\u516c\u53f8\u73b0\u91d1") || lower.includes("company cash"));
  if (useDueToDirector) {
    creditCode = pickBestAccountCode(input.accounts, { type: "liability", keywords: ["\u8463\u4e8b", "\u501f\u6b3e", "\u5e94\u4ed8", "due", "loan"] });
    if (!creditCode) warnings.push(t("未找到“应付董事/董事借款”科目，将尝试使用现金/银行科目。", "No 'due to director/loan' account; falling back to cash/bank.") );
  }
  if (!creditCode) {
    if (payByCash) creditCode = pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u73b0\u91d1", "cash"] });
    if (!creditCode && payByBank) creditCode = pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u94f6\u884c", "bank"] });
    if (!creditCode) creditCode = pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u73b0\u91d1", "cash", "\u94f6\u884c", "bank"] });
    if (!creditCode) missing.push(t("缺少现金/银行科目用于贷方", "Missing cash/bank account (credit)") );
  }

  const codeLines = [
    {
      accountCode: debitCode || "",
      description: t("购置/费用", "Purchase/expense"),
      debitTxn: amount || 0,
      creditTxn: 0,
    },
    {
      accountCode: creditCode || "",
      description: t("付款", "Payment"),
      debitTxn: 0,
      creditTxn: amount || 0,
    },
  ];

  const lines = codeLines.map((l) => {
    const code = String(l.accountCode || "");
    const accountId = code ? input.accountIdByCode.get(code) || "" : "";
    return {
      accountCode: code,
      accountId,
      accountName: code ? input.accountNameByCode.get(code) || "" : "",
      description: l.description,
      debitTxn: Math.max(0, Number(l.debitTxn) || 0),
      creditTxn: Math.max(0, Number(l.creditTxn) || 0),
    };
  });

  if (lines.some((l) => !l.accountId)) {
    return { draft: null, preview: null, warnings, missing };
  }
  if (!amount) {
    return { draft: null, preview: null, warnings, missing };
  }

  const memo = input.extraMemo ? `${input.extraMemo}` : "";
  return {
    draft: {
      entryDate: input.forcedEntryDate,
      currency: ccy,
      fxRate: ccy === input.baseCurrency ? 1 : 1,
      memo,
      lines: lines.map((l) => ({ accountId: l.accountId, description: l.description, costCenterId: null, debitTxn: l.debitTxn, creditTxn: l.creditTxn })),
    },
    preview: {
      entryDate: input.forcedEntryDate,
      currency: ccy,
      fxRate: ccy === input.baseCurrency ? 1 : 1,
      memo,
      lines: lines.map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, description: l.description, debitTxn: l.debitTxn, creditTxn: l.creditTxn })),
    },
    warnings,
    missing,
  };
}

router.post("/journal-suggest", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const bodySchema = z.object({
    text: z.string().trim().min(1).max(2000),
    memo: z.string().trim().max(200).optional(),
    entryDate: z.string().min(10).optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const lang = detectLang(parsed.data.text);

  const sql = getSql();
  const orgRows = await sql`SELECT base_currency as "baseCurrency" FROM organizations WHERE id = ${orgId} LIMIT 1`;
  const baseCurrency = String((orgRows[0] as any)?.baseCurrency || "BASE").toUpperCase();

  const accounts = (await sql`
    SELECT id, code, name, type
    FROM accounts
    WHERE org_id = ${orgId} AND is_active = true
    ORDER BY code ASC
  `) as any[];

  const accountIdByCode = new Map(accounts.map((a) => [String(a.code), String(a.id)]));
  const accountNameByCode = new Map(accounts.map((a) => [String(a.code), String(a.name)]));

  const today = new Date().toISOString().slice(0, 10);
  const forcedEntryDate = parsed.data.entryDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.data.entryDate) ? parsed.data.entryDate : today;
  const extraMemo = parsed.data.memo ? parsed.data.memo.trim() : "";

  const suggestion = buildHeuristicSuggestion({
    text: parsed.data.text,
    lang,
    baseCurrency,
    forcedEntryDate,
    extraMemo,
    accounts,
    accountIdByCode,
    accountNameByCode,
  });
  res.status(200).json({ success: true, suggestion });
});

export default router;
