export function detectLang(text: string): "zh" | "en" {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}

export function pickBestAccountCode(accounts: any[], opts: { type?: string; keywords: string[] }): string | null {
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

export function parseFirstAmountAndCurrency(text: string): { amount: number | null; currency: string | null } {
  const t = String(text || "");
  const re = /(\d+(?:\.\d+)?)\s*([A-Za-z]{3})(?![A-Za-z])/g;
  let bestAmount: number | null = null;
  let bestCurrency: string | null = null;
  for (const m of t.matchAll(re)) {
    const amount = Number(m[1]);
    const currency = String(m[2] || "").toUpperCase().slice(0, 3);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!currency) continue;
    bestAmount = amount;
    bestCurrency = currency;
  }
  return { amount: bestAmount, currency: bestCurrency };
}

export function buildHeuristicSuggestion(input: {
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
  if (!amount) warnings.push(t("缺少金额（例如：20000 MYR）", "Missing amount (e.g., 20000 MYR)"));
  if (!currency) warnings.push(t(`未明确币种，默认使用 ${input.baseCurrency}`, `Currency not specified; defaulting to ${input.baseCurrency}`));

  const lower = input.text.toLowerCase();
  const isVehicle = /\bcar\b|vehicle|\u6c7d\u8f66|\u8f66\u8f86|\u8f66/.test(lower);
  const isFixedAssetNew = /fixed\s*asset|\u56fa\u5b9a\u8d44\u4ea7|\u65b0\u589e\u56fa\u5b9a\u8d44\u4ea7|ppe/.test(lower);
  const isSale = /sell|sold|sale|dispose|disposal|\u51fa\u552e|\u5356|\u9500\u552e|\u5904\u7f6e/.test(lower);

  const parseLabeledNumber = (patterns: RegExp[]): number | null => {
    for (const re of patterns) {
      const m = input.text.match(re);
      const v = m?.[1] != null ? Number(m[1]) : NaN;
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  };

  const costHint = parseLabeledNumber([
    /(?:\b|\s)(?:cost|original\s*cost)\s*[:：]?\s*(\d+(?:\.\d+)?)/i,
    /(?:原值|成本|购置价|购买价|车价)\s*[:：]?\s*(\d+(?:\.\d+)?)/,
  ]);
  const accumHint = parseLabeledNumber([
    /(?:\b|\s)(?:accum\s*dep|accumulated\s*depreciation)\s*[:：]?\s*(\d+(?:\.\d+)?)/i,
    /(?:累计折旧|累折|折旧累计)\s*[:：]?\s*(\d+(?:\.\d+)?)/,
  ]);
  const bookHint = parseLabeledNumber([
    /(?:\b|\s)(?:nbv|book\s*value|carrying\s*value)\s*[:：]?\s*(\d+(?:\.\d+)?)/i,
    /(?:账面价值|净值|残值\s*\(账面\))\s*[:：]?\s*(\d+(?:\.\d+)?)/,
  ]);

  const payByCash = /cash|\u73b0\u91d1/.test(lower);
  const payByBank = /transfer|bank|\u94f6\u884c|\u8f6c\u8d26/.test(lower);
  const payUnpaid = /unpaid|\u672a\u652f\u4ed8/.test(lower);

  const hasVendor = /vendor|supplier|\u4f9b\u5e94\u5546/.test(lower);
  const hasCustomer = /customer|\u5ba2\u6237/.test(lower);
  const hasInventory = /\u73b0\u6709\u5b58\u8d27|\u5b58\u8d27|\binventory\b|\bfifo\b/.test(lower);
  const hasDirector = /director|\u8463\u4e8b/.test(lower);
  const hasCompany = /company|\u516c\u53f8/.test(lower);

  const isCustomerFlow = hasCustomer && !hasVendor && (payUnpaid || (!payByCash && !payByBank));
  const isVendorFlow = hasVendor && !hasCustomer && (payUnpaid || (!payByCash && !payByBank));

  const isPurchase = /buy|bought|purchase|acquir|\u4e70|\u8d2d\u4e70|\u8d2d\u5165|\u91c7\u8d2d/.test(lower);

  let debitCode: string | null = null;
  let creditCode: string | null = null;

  const isFixedAssetDisposal = isSale && (isVehicle || /\u56fa\u5b9a\u8d44\u4ea7|ppe|\u5904\u7f6e/.test(lower));

  if (!isSale && isPurchase && hasInventory) {
    const has1500 = input.accounts.some((a) => String(a.code || "") === "1500");
    debitCode = has1500
      ? "1500"
      : pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u5b58\u8d27", "inventory"] }) ||
        input.accounts.find((a) => String(a.type) === "asset")?.code ||
        null;

    if (payByCash) {
      creditCode = pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u73b0\u91d1", "cash"] });
    } else if (payByBank) {
      creditCode = pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u94f6\u884c", "bank"] });
    } else {
      const has2000 = input.accounts.some((a) => String(a.code || "") === "2000");
      creditCode = has2000
        ? "2000"
        : pickBestAccountCode(input.accounts, { type: "liability", keywords: ["\u5e94\u4ed8", "\u4f9b\u5e94\u5546", "payable", "ap"] }) ||
          input.accounts.find((a) => String(a.type) === "liability")?.code ||
          null;
    }
    if (!creditCode) creditCode = input.accounts.find((a) => String(a.type) === "liability")?.code || input.accounts[0]?.code || null;

    if (!amount) {
      missing.push(t("缺少金额（例如：15 MYR）", "Missing amount (e.g., 15 MYR)"));
      return { draft: null, preview: null, warnings, missing };
    }

    const lines = [
      { accountCode: debitCode || "", description: t("存货", "Inventory"), debitTxn: amount || 0, creditTxn: 0 },
      { accountCode: creditCode || "", description: payUnpaid ? t("应付", "Payable") : t("付款", "Payment"), debitTxn: 0, creditTxn: amount || 0 },
    ].map((l) => {
      const code = String(l.accountCode || "");
      const accountId = code ? input.accountIdByCode.get(code) || "" : "";
      return {
        accountCode: code,
        accountId,
        accountName: code ? input.accountNameByCode.get(code) || "" : "",
        description: l.description,
        debitTxn: l.debitTxn,
        creditTxn: l.creditTxn,
      };
    });

    const entryDate = input.forcedEntryDate || "";
    const draft = {
      entryDate,
      currency: ccy,
      fxRate: 1,
      memo: input.extraMemo || "",
      lines: lines.map((l) => ({ accountId: l.accountId, description: l.description, costCenterId: null, debitTxn: l.debitTxn, creditTxn: l.creditTxn })),
    };
    const preview = { entryDate, currency: ccy, fxRate: 1, memo: input.extraMemo || "", lines };
    return { draft, preview, warnings, missing };
  }

  if (isSale) {
    if (payByCash) {
      debitCode = pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u73b0\u91d1", "cash"] });
    } else if (payByBank) {
      debitCode = pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u94f6\u884c", "bank"] });
    } else {
      const has1200 = input.accounts.some((a) => String(a.code || "") === "1200");
      debitCode = has1200
        ? "1200"
        : pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u5e94\u6536", "\u5ba2\u6237", "receivable", "ar"] });
    }
    if (!debitCode) debitCode = input.accounts.find((a) => String(a.type) === "asset")?.code || input.accounts[0]?.code || null;

    if (!isFixedAssetDisposal) {
      creditCode =
        pickBestAccountCode(input.accounts, { type: "income", keywords: ["\u6536\u5165", "\u8425\u4e1a\u6536\u5165", "\u9500\u552e", "revenue", "sales", "income"] }) ||
        input.accounts.find((a) => String(a.type) === "income")?.code ||
        null;
      if (!creditCode) {
        missing.push(t("缺少收入科目：请在设置新增收入科目（例如 4000 销售收入）。", "Missing income account: please add one in Settings (e.g., 4000 Sales)."));
        return { draft: null, preview: null, warnings, missing };
      }
    }

    if (isFixedAssetDisposal) {
      let cost = costHint;
      let accum = accumHint;
      let book = bookHint;
      if (cost != null && book != null && accum == null) {
        const a = cost - book;
        accum = Number.isFinite(a) && a >= 0 ? a : null;
      }
      if (cost != null && accum != null && book == null) {
        const b = cost - accum;
        book = Number.isFinite(b) && b >= 0 ? b : null;
      }
      if (book != null && accum != null && cost == null) {
        const c = book + accum;
        cost = Number.isFinite(c) && c > 0 ? c : null;
      }

      const has1600 = input.accounts.some((a) => String(a.code || "") === "1600");
      const assetCode = has1600
        ? "1600"
        : pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u56fa\u5b9a\u8d44\u4ea7", "ppe", "vehicle", "car", "\u8f66"] }) ||
          null;
      const accumCode =
        pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u7d2f\u8ba1\u6298\u65e7", "\u7d2f\u6298", "accum", "depreciation"] }) ||
        null;
      const has7000 = input.accounts.some((a) => String(a.code || "") === "7000");
      const gainCode = has7000
        ? "7000"
        : pickBestAccountCode(input.accounts, { type: "income", keywords: ["\u5904\u7f6e\u6536\u76ca", "\u5904\u7f6e\u5229\u5f97", "gain", "disposal"] }) ||
          input.accounts.find((a) => String(a.type) === "income")?.code ||
          null;
      const lossCode = gainCode;

      const missingParts: string[] = [];
      if (!assetCode) missingParts.push(t("固定资产科目（例如 1600）", "Fixed asset account (e.g., 1600)"));
      if (!accumCode) missingParts.push(t("累计折旧科目（例如 1610）", "Accumulated depreciation account (e.g., 1610)"));
      if (!amount) missingParts.push(t("售价金额（例如 50000 MYR）", "Sale amount (e.g., 50000 MYR)"));
      if (cost == null && book == null) missingParts.push(t("车辆原值(成本) 与累计折旧（或账面价值）", "Asset cost + accum dep (or book value)"));
      if (missingParts.length) {
        missing.push(
          t(
            `处置固定资产需要补充：${missingParts.join("、")}`,
            `Fixed asset disposal needs: ${missingParts.join(", ")}`,
          ),
        );
        return { draft: null, preview: null, warnings, missing };
      }

      const proceeds = amount || 0;
      const assetCost = Number(cost || 0);
      const assetAccum = Number(accum || 0);
      const nbv = assetCost - assetAccum;
      const gainLoss = proceeds - nbv;

      if (Math.abs(gainLoss) >= 0.005) {
        if (!gainCode) {
          missing.push(t("缺少处置损益科目：请新增 7000 处置收益/损失。", "Missing disposal gain/loss account: please add 7000 Gain/Loss on Disposal."));
          return { draft: null, preview: null, warnings, missing };
        }
      }

      const disposalLines = [
        {
          accountCode: debitCode || "",
          description: payByCash || payByBank ? t("收款", "Receipt") : t("应收", "Receivable"),
          debitTxn: proceeds,
          creditTxn: 0,
        },
        {
          accountCode: accumCode || "",
          description: t("累计折旧冲回", "Reverse accum dep"),
          debitTxn: assetAccum,
          creditTxn: 0,
        },
        {
          accountCode: assetCode || "",
          description: t("处置固定资产", "Dispose fixed asset"),
          debitTxn: 0,
          creditTxn: assetCost,
        },
      ];
      if (Math.abs(gainLoss) >= 0.005) {
        if (gainLoss > 0) {
          disposalLines.push({
            accountCode: gainCode || "",
            description: t("处置收益", "Disposal gain"),
            debitTxn: 0,
            creditTxn: Math.round(gainLoss * 100) / 100,
          });
        } else {
          disposalLines.push({
            accountCode: lossCode || "",
            description: t("处置损失", "Disposal loss"),
            debitTxn: Math.round(Math.abs(gainLoss) * 100) / 100,
            creditTxn: 0,
          });
        }
      }

      const lines = disposalLines.map((l) => {
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
        missing.push(t("处置分录科目匹配失败，请检查科目表。", "Account mapping failed for disposal; please check chart of accounts."));
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
  } else {
    if (isCustomerFlow) {
      const has1200 = input.accounts.some((a) => String(a.code || "") === "1200");
      debitCode = has1200
        ? "1200"
        : pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u5e94\u6536", "\u5ba2\u6237", "receivable", "ar"] }) ||
          input.accounts.find((a) => String(a.type) === "asset")?.code ||
          input.accounts[0]?.code ||
          null;
      creditCode =
        pickBestAccountCode(input.accounts, { type: "income", keywords: ["\u6536\u5165", "\u8425\u4e1a\u6536\u5165", "\u9500\u552e", "revenue", "sales", "income"] }) ||
        input.accounts.find((a) => String(a.type) === "income")?.code ||
        null;
      if (!creditCode) {
        missing.push(t("缺少收入科目：请在设置新增收入科目（例如 4000 销售收入）。", "Missing income account: please add one in Settings (e.g., 4000 Sales)."));
        return { draft: null, preview: null, warnings, missing };
      }
    }

    if (!debitCode) {
      if (isVehicle || isFixedAssetNew) {
        const has1600 = input.accounts.some((a) => String(a.code || "") === "1600");
        debitCode = has1600
          ? "1600"
          : pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u8f66", "\u6c7d\u8f66", "\u4ea4\u901a", "vehicle", "car", "motor"] }) ||
            pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u56fa\u5b9a\u8d44\u4ea7", "ppe", "property", "plant", "equipment"] });
      }
    }

    if (
      !debitCode &&
      isPurchase &&
      !hasInventory &&
      !isFixedAssetNew &&
      !isVehicle &&
      !/rent|rental|fuel|gas|petrol|salary|wage|utilities|electric|water|internet|office|suppl|repair|maintenance|insurance|commission|advertis|marketing|travel|meal|\u79df|\u79df\u91d1|\u6c34\u7535|\u5de5\u8d44|\u85aa|\u6cb9|\u6c7d\u6cb9|\u529e\u516c|\u6587\u5177|\u8017\u6750|\u7ef4\u4fee|\u4fdd\u517b|\u4fdd\u9669|\u5e7f\u544a|\u8425\u9500|\u65c5\u884c|\u5dee\u65c5|\u9910/i.test(lower)
    ) {
      missing.push(t("请说明用途/性质：这是存货、固定资产，还是费用？", "Please clarify purpose/type: inventory, fixed asset, or expense?"));
      return { draft: null, preview: null, warnings, missing };
    }

    if (!debitCode) {
      debitCode = pickBestAccountCode(input.accounts, { type: "expense", keywords: ["\u8d2d\u4e70", "\u8d39\u7528", "expense"] });
      if (!debitCode) debitCode = input.accounts.find((a) => String(a.type) === "expense")?.code || input.accounts[0]?.code || null;
    }

    const useDueToDirector = hasDirector && hasCompany && !(lower.includes("\u516c\u53f8\u73b0\u91d1") || lower.includes("company cash"));
    if (useDueToDirector) {
      creditCode = pickBestAccountCode(input.accounts, { type: "liability", keywords: ["\u8463\u4e8b", "\u501f\u6b3e", "\u5e94\u4ed8", "due", "loan"] });
      if (!creditCode) warnings.push(t("未找到“应付董事/董事借款”科目，将尝试使用应付/现金/银行科目。", "No 'due to director/loan' account; falling back to payable/cash/bank."));
    }

    if (!creditCode && isVendorFlow) {
      const has2000 = input.accounts.some((a) => String(a.code || "") === "2000");
      creditCode = has2000
        ? "2000"
        : pickBestAccountCode(input.accounts, { type: "liability", keywords: ["\u5e94\u4ed8", "\u4f9b\u5e94\u5546", "payable", "ap", "vendor"] });
    }

    if (!creditCode && payUnpaid && !payByCash && !payByBank && !isCustomerFlow && !useDueToDirector) {
      const has2000 = input.accounts.some((a) => String(a.code || "") === "2000");
      creditCode = has2000
        ? "2000"
        : pickBestAccountCode(input.accounts, { type: "liability", keywords: ["\u5e94\u4ed8", "\u4f9b\u5e94\u5546", "payable", "ap"] }) ||
          input.accounts.find((a) => String(a.type) === "liability")?.code ||
          null;
    }

    if (!creditCode) {
      if (payByCash) creditCode = pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u73b0\u91d1", "cash"] });
      if (!creditCode && payByBank) creditCode = pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u94f6\u884c", "bank"] });
      if (!creditCode) creditCode = pickBestAccountCode(input.accounts, { type: "asset", keywords: ["\u73b0\u91d1", "cash", "\u94f6\u884c", "bank"] });
      if (!creditCode) creditCode = input.accounts.find((a) => String(a.type) === "asset")?.code || input.accounts[0]?.code || null;
    }
  }

  const codeLines = isSale
    ? [
        {
          accountCode: debitCode || "",
          description: payByCash || payByBank ? t("收款", "Receipt") : t("应收", "Receivable"),
          debitTxn: amount || 0,
          creditTxn: 0,
        },
        {
          accountCode: creditCode || "",
          description: t("收入", "Revenue"),
          debitTxn: 0,
          creditTxn: amount || 0,
        },
      ]
    : isCustomerFlow
      ? [
          {
            accountCode: debitCode || "",
            description: t("客户应收", "Accounts receivable"),
            debitTxn: amount || 0,
            creditTxn: 0,
          },
          {
            accountCode: creditCode || "",
            description: t("收入", "Revenue"),
            debitTxn: 0,
            creditTxn: amount || 0,
          },
        ]
      : [
          {
            accountCode: debitCode || "",
            description: t("购置/费用", "Purchase/expense"),
            debitTxn: amount || 0,
            creditTxn: 0,
          },
          {
            accountCode: creditCode || "",
            description: isVendorFlow || (payUnpaid && !payByCash && !payByBank) ? t("供应商应付", "Accounts payable") : t("付款", "Payment"),
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
