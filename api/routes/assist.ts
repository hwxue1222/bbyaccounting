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

function normalizeCode(input: unknown): string {
  const s = typeof input === "string" ? input.trim() : "";
  const m = s.match(/\d{3,6}/);
  return m ? m[0] : s;
}

function stripCodeFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : t;
}

function normalizeGeminiModel(input: unknown): string {
  const s = typeof input === "string" ? input.trim() : "";
  if (!s) return "";
  return s.startsWith("models/") ? s.slice("models/".length) : s;
}

async function listGeminiModels(apiKey: string): Promise<string[]> {
  const urls = [
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey)}`,
  ];
  for (const u of urls) {
    const r = await fetch(u, { method: "GET" });
    if (!r.ok) continue;
    const j = (await r.json()) as any;
    const models = Array.isArray(j?.models) ? j.models : [];
    const names = models
      .filter((m: any) => Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map((m: any) => normalizeGeminiModel(m?.name))
      .filter((x: any) => typeof x === "string" && x.trim());
    if (names.length) return Array.from(new Set(names));
  }
  return [];
}

function pickPreferredGeminiModel(models: string[]): string {
  if (!models.length) return "";
  const lower = models.map((m) => ({ m, l: m.toLowerCase() }));
  const flash = lower.find((x) => x.l.includes("flash"));
  if (flash) return flash.m;
  return models[0];
}

function getGeminiTextFromResponse(raw: any): string {
  const parts = raw?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
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

  const apiKey = typeof process.env.GOOGLE_API_KEY === "string" ? process.env.GOOGLE_API_KEY : null;
  if (!apiKey) {
    res.status(503).json({ success: false, error: "Missing GOOGLE_API_KEY" });
    return;
  }

  const sql = getSql();
  const orgRows = await sql`SELECT base_currency as "baseCurrency" FROM organizations WHERE id = ${orgId} LIMIT 1`;
  const baseCurrency = String((orgRows[0] as any)?.baseCurrency || "BASE").toUpperCase();

  const accounts = (await sql`
    SELECT id, code, name, type
    FROM accounts
    WHERE org_id = ${orgId} AND is_active = true
    ORDER BY code ASC
  `) as any[];

  const costCenters = (await sql`
    SELECT id, code, name
    FROM cost_centers
    WHERE org_id = ${orgId}
    ORDER BY code ASC
  `) as any[];

  const items = (await sql`
    SELECT id, sku, name, uom
    FROM inventory_items
    WHERE org_id = ${orgId} AND is_active = true
    ORDER BY sku ASC NULLS LAST, name ASC
  `) as any[];

  const accountList = accounts.map((a) => `${a.code} ${a.name} (${a.type})`).join("\n");
  const costCenterList = costCenters.map((c) => `${c.code} ${c.name}`).join("\n");
  const itemList = items.map((it) => `${it.sku ? it.sku + " " : ""}${it.name} [${it.uom}]`).join("\n");

  const today = new Date().toISOString().slice(0, 10);
  const forcedEntryDate = parsed.data.entryDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.data.entryDate) ? parsed.data.entryDate : today;
  const extraMemo = parsed.data.memo ? parsed.data.memo.trim() : "";

  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      entryDate: { type: "string" },
      currency: { type: "string" },
      fxRate: { type: "number" },
      memo: { type: "string" },
      lines: {
        type: "array",
        minItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            accountCode: { type: "string" },
            description: { type: "string" },
            costCenterCode: { type: "string" },
            debitTxn: { type: "number" },
            creditTxn: { type: "number" },
          },
          required: ["accountCode", "debitTxn", "creditTxn"],
        },
      },
      inventory: {
        type: "object",
        additionalProperties: false,
        properties: {
          linkLineNo: { type: "integer" },
          details: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                moveType: { type: "string", enum: ["receipt", "shipment"] },
                itemKey: { type: "string" },
                qty: { type: "number" },
                unitCostTxn: { type: "number" },
              },
              required: ["moveType", "itemKey", "qty"],
            },
          },
        },
      },
      missing: { type: "array", items: { type: "string" } },
    },
    required: ["currency", "fxRate", "memo", "lines"],
  } as const;

  const prompt = {
    baseCurrency,
    entryDate: forcedEntryDate,
    extraMemo,
    accounts: accountList,
    costCenters: costCenterList,
    inventoryItems: itemList,
  };

  const system =
    "你是会计分录助手。根据用户输入生成可直接过账的分录建议。\n" +
    "严格输出 JSON，符合给定 schema。金额必须借贷平衡；debitTxn/creditTxn 为交易币金额；不允许同时借贷都为正。\n" +
    "只允许使用提供的科目代码与成本中心代码；若缺少合适科目/商品，请把需求写入 missing 数组，并用最接近的现有科目暂代。\n" +
    "inventory.details.itemKey 必须匹配提供的库存商品：优先用 SKU，否则用商品名称。\n" +
    "entryDate 如果用户未给出，使用提供的 entryDate。currency 如果用户未给出，使用 baseCurrency。fxRate 同币种为 1。";

  const user =
    `用户输入：${parsed.data.text}\n\n` +
    `约束与可用列表：\n${JSON.stringify(prompt)}\n`;

  const envModel = normalizeGeminiModel(process.env.GEMINI_MODEL);
  const discoveredModels = envModel ? [] : await listGeminiModels(apiKey);
  const chosenModel = envModel || pickPreferredGeminiModel(discoveredModels) || "";

  async function callGemini(
    model: string,
    apiVersion: "v1beta" | "v1",
    withSchema: boolean,
    systemText: string = system,
    userText: string = user,
  ): Promise<{ ok: boolean; status: number; text: string; model: string; apiVersion: string }> {
    const payload: any = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    };
    if (withSchema) payload.generationConfig.responseSchema = jsonSchema;

    const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let fetchResp: globalThis.Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      fetchResp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (fetchResp.ok) break;
      if (![429, 500, 502, 503, 504].includes(fetchResp.status)) break;
      await new Promise((r) => setTimeout(r, attempt === 0 ? 250 : attempt === 1 ? 800 : 1600));
    }
    const status = fetchResp ? fetchResp.status : 0;
    const rawText = fetchResp ? await fetchResp.text() : "";
    return { ok: !!fetchResp?.ok, status, text: rawText, model, apiVersion };
  }

  let gem: { ok: boolean; status: number; text: string; model: string; apiVersion: string } | null = null;

  if (chosenModel) {
    gem = await callGemini(chosenModel, "v1beta", true);
    if (!gem.ok && gem.status === 400) gem = await callGemini(chosenModel, "v1beta", false);
    if (!gem.ok && gem.status === 404) {
      gem = await callGemini(chosenModel, "v1", true);
      if (!gem.ok && gem.status === 400) gem = await callGemini(chosenModel, "v1", false);
    }
  }

  if (!gem || (!gem.ok && gem.status === 404 && !envModel)) {
    const models = discoveredModels.length ? discoveredModels : await listGeminiModels(apiKey);
    const picked = pickPreferredGeminiModel(models);
    if (picked) {
      gem = await callGemini(picked, "v1beta", true);
      if (!gem.ok && gem.status === 400) gem = await callGemini(picked, "v1beta", false);
      if (!gem.ok && gem.status === 404) {
        gem = await callGemini(picked, "v1", true);
        if (!gem.ok && gem.status === 400) gem = await callGemini(picked, "v1", false);
      }
    }
  }

  if (!gem || !gem.ok) {
    const status = gem?.status ?? 0;
    let detail = gem?.text ?? "";
    try {
      const j = JSON.parse(detail);
      const msg = j?.error?.message || j?.message || j?.error || j?.msg;
      if (typeof msg === "string" && msg.trim()) detail = msg.trim();
    } catch {
      void 0;
    }
    const safeDetail = String(detail || "").replace(/\s+/g, " ").trim().slice(0, 280);
    const hint =
      status === 401 || status === 403
        ? "（请检查 Vercel 的 GOOGLE_API_KEY 是否正确/有权限）"
        : status === 429
          ? "（可能触发限流/额度不足，稍后再试）"
          : status === 400
            ? "（请求参数可能不被该模型支持，可尝试更换 GEMINI_MODEL）"
            : status === 404
              ? "（模型不存在/无权限。建议用 ListModels 查可用模型，并设置 GEMINI_MODEL）"
            : "";
    let modelList: string[] = [];
    if (status === 404) {
      modelList = await listGeminiModels(apiKey);
    }
    const used = gem?.model ? ` model=${gem.model}` : "";
    const ver = gem?.apiVersion ? ` api=${gem.apiVersion}` : "";
    const listText = modelList.length ? ` Available models: ${modelList.slice(0, 12).join(", ")}` : "";
    res
      .status(502)
      .json({ success: false, error: `Google Gemini API error (${status})${used}${ver} ${hint}${safeDetail ? ": " + safeDetail : ""}${listText}` });
    return;
  }

  const raw = gem.text ? (JSON.parse(gem.text) as any) : null;
  let content = getGeminiTextFromResponse(raw);
  if (!content) {
    res.status(502).json({ success: false, error: "Google Gemini returned empty content" });
    return;
  }

  let suggested: any;
  try {
    suggested = JSON.parse(stripCodeFences(content));
  } catch {
    res.status(502).json({ success: false, error: "Google Gemini returned invalid JSON" });
    return;
  }

  const accountIdByCode = new Map(accounts.map((a) => [String(a.code), String(a.id)]));
  const accountNameByCode = new Map(accounts.map((a) => [String(a.code), String(a.name)]));
  const ccIdByCode = new Map(costCenters.map((c) => [String(c.code), String(c.id)]));
  const itemIdByKey = new Map<string, string>();
  for (const it of items) {
    if (it.sku) itemIdByKey.set(String(it.sku), String(it.id));
    itemIdByKey.set(String(it.name), String(it.id));
  }

  const warnings: string[] = [];
  const missing: string[] = Array.isArray(suggested?.missing) ? suggested.missing.map((x: any) => String(x)) : [];

  const currency = typeof suggested?.currency === "string" && suggested.currency.trim() ? String(suggested.currency).toUpperCase().slice(0, 3) : baseCurrency;
  const fxRate = Number(suggested?.fxRate) || 1;
  const memo = typeof suggested?.memo === "string" ? suggested.memo.trim() : "";
  const entryDate = typeof suggested?.entryDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(suggested.entryDate) ? suggested.entryDate : forcedEntryDate;

  const linesIn: any[] = Array.isArray(suggested?.lines) ? suggested.lines : [];
  if (linesIn.length < 2) {
    const repairUser =
      "上一次输出不符合要求：必须包含 lines 数组且至少 2 行，并且借贷平衡。\n" +
      "请你只输出 JSON，不要解释文字。\n\n" +
      `上一次输出：\n${stripCodeFences(content)}\n\n` +
      `原始用户输入：${parsed.data.text}\n\n` +
      `约束与可用列表：\n${JSON.stringify(prompt)}\n`;

    let repaired = await callGemini(gem.model, gem.apiVersion as any, true, system, repairUser);
    if (!repaired.ok && repaired.status === 400) {
      repaired = await callGemini(gem.model, gem.apiVersion as any, false, system, repairUser);
    }

    if (repaired.ok) {
      const raw2 = repaired.text ? (JSON.parse(repaired.text) as any) : null;
      const content2 = getGeminiTextFromResponse(raw2);
      if (content2) {
        content = content2;
        try {
          suggested = JSON.parse(stripCodeFences(content));
        } catch {
          res.status(502).json({ success: false, error: "Google Gemini returned invalid JSON" });
          return;
        }
      }
    }

    const linesRetry: any[] = Array.isArray(suggested?.lines) ? suggested.lines : [];
    if (linesRetry.length < 2) {
      res.status(502).json({
        success: false,
        error:
          "Google Gemini output is incomplete (missing journal lines). Try adding currency/amount or rephrasing, e.g. 'Bought a car for 30000 SGD, paid by bank transfer'.",
      });
      return;
    }
  }

  const lines = linesIn.map((l) => {
    const code = normalizeCode(l?.accountCode);
    const accountId = accountIdByCode.get(code) || null;
    if (!accountId) {
      missing.push(`缺少科目 ${code}`);
      warnings.push(`找不到科目代码 ${code}`);
    }
    const ccCode = typeof l?.costCenterCode === "string" && l.costCenterCode.trim() ? l.costCenterCode.trim() : "";
    const costCenterId = ccCode ? ccIdByCode.get(ccCode) || null : null;
    if (ccCode && !costCenterId) {
      warnings.push(`找不到成本中心代码 ${ccCode}`);
    }
    const debitTxn = Math.max(0, Number(l?.debitTxn) || 0);
    const creditTxn = Math.max(0, Number(l?.creditTxn) || 0);
    return {
      accountCode: code,
      accountId: accountId || "",
      description: typeof l?.description === "string" && l.description.trim() ? l.description.trim() : undefined,
      costCenterId,
      debitTxn,
      creditTxn,
    };
  });

  if (lines.some((l) => !l.accountId)) {
    res.status(400).json({ success: false, error: "科目匹配失败", missing, warnings });
    return;
  }

  const debit = lines.reduce((s, l) => s + (Number(l.debitTxn) || 0), 0);
  const credit = lines.reduce((s, l) => s + (Number(l.creditTxn) || 0), 0);
  const diff = Math.round((debit - credit) * 100) / 100;
  if (diff !== 0) {
    res.status(400).json({ success: false, error: "建议分录借贷不平衡", diff, missing, warnings });
    return;
  }

  let inventoryDetails: any[] | undefined;
  let inventoryLinkLineNo: number | undefined;

  const inv = suggested?.inventory;
  const invDetailsIn: any[] = Array.isArray(inv?.details) ? inv.details : [];
  if (invDetailsIn.length) {
    inventoryDetails = invDetailsIn
      .map((d) => {
        const moveType = d?.moveType === "shipment" ? "shipment" : d?.moveType === "receipt" ? "receipt" : null;
        if (!moveType) return null;
        const qty = Number(d?.qty) || 0;
        const unitCostTxn = Number(d?.unitCostTxn) || 0;
        const key = typeof d?.itemKey === "string" ? d.itemKey.trim() : "";
        const itemId = key ? itemIdByKey.get(key) || null : null;
        if (!itemId) {
          missing.push(`缺少库存商品 ${key || "(空)"}`);
          warnings.push(`找不到库存商品 ${key || "(空)"}`);
          return null;
        }
        if (qty <= 0) return null;
        if (moveType === "receipt") {
          if (unitCostTxn <= 0) return null;
          return { moveType, itemId, qty, unitCostTxn };
        }
        return { moveType, itemId, qty };
      })
      .filter(Boolean) as any[];

    if (!inventoryDetails.length) {
      inventoryDetails = undefined;
    } else {
      const ll = Number(inv?.linkLineNo);
      inventoryLinkLineNo = Number.isFinite(ll) && ll > 0 ? Math.trunc(ll) : undefined;
      if (!inventoryLinkLineNo) inventoryLinkLineNo = 1;
    }
  }

  const finalMemo = extraMemo ? (memo ? `${memo}；${extraMemo}` : extraMemo) : memo;

  res.status(200).json({
    success: true,
    data: {
      suggestion: {
        draft: {
          entryDate,
          currency,
          fxRate,
          memo: finalMemo,
          inventoryLinkLineNo,
          inventoryDetails,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            description: l.description,
            costCenterId: l.costCenterId,
            debitTxn: l.debitTxn,
            creditTxn: l.creditTxn,
          })),
        },
        preview: {
          entryDate,
          currency,
          fxRate,
          memo: finalMemo,
          lines: lines.map((l) => ({
            accountCode: l.accountCode,
            accountName: accountNameByCode.get(l.accountCode) || "",
            description: l.description,
            debitTxn: l.debitTxn,
            creditTxn: l.creditTxn,
          })),
          inventoryLinkLineNo,
          inventoryDetails,
        },
        warnings,
        missing,
      },
    },
  });
});

export default router;
