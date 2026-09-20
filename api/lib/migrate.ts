import crypto from "crypto";
import { getSql } from "./db.js";

let migrated = false;
let migrating: Promise<void> | null = null;

export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  if (migrating) {
    await migrating;
    return;
  }
  migrating = (async () => {
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const BASE_MIGRATION_ID = "base_2026_09";
  const FX_FIX_MIGRATION_ID = "fx_rate_txn_per_base_2026_09";
  const PERF_INDEXES_MIGRATION_ID = "perf_indexes_2026_09";
  const JOURNAL_POSTED_SOURCE_MIGRATION_ID = "journal_posted_source_2026_09";

  let baseApplied = false;
  try {
    const applied = await sql`SELECT 1 FROM schema_migrations WHERE id = ${BASE_MIGRATION_ID} LIMIT 1`;
    baseApplied = Boolean((applied as any[])?.length);
  } catch {
    baseApplied = false;
  }

  let postedSourceApplied = false;
  try {
    const applied = await sql`SELECT 1 FROM schema_migrations WHERE id = ${JOURNAL_POSTED_SOURCE_MIGRATION_ID} LIMIT 1`;
    postedSourceApplied = Boolean((applied as any[])?.length);
  } catch {
    postedSourceApplied = false;
  }

  try {
    const rows = await sql`
      SELECT
        to_regclass('public.organizations') IS NOT NULL AS org_ok,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'industry'
        ) AS org_industry_ok,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'deleted_at'
        ) AS org_deleted_ok,
        to_regclass('public.accounts') IS NOT NULL AS accounts_ok,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'link_fixed_assets'
        ) AS accounts_link_fa_ok,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'link_inventory_fifo'
        ) AS accounts_link_inv_ok,
        to_regclass('public.journal_entries') IS NOT NULL AS journals_ok,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'journal_entries' AND column_name = 'inventory_impact'
        ) AS journals_inv_ok,
        to_regclass('public.journal_lines') IS NOT NULL AS journal_lines_ok,
        to_regclass('public.attachments') IS NOT NULL AS attachments_ok
    `;
    const s: any = (rows as any[])?.[0];
    const schemaReady =
      !!s?.org_ok &&
      !!s?.org_industry_ok &&
      !!s?.org_deleted_ok &&
      !!s?.accounts_ok &&
      !!s?.accounts_link_fa_ok &&
      !!s?.accounts_link_inv_ok &&
      !!s?.journals_ok &&
      !!s?.journals_inv_ok &&
      !!s?.journal_lines_ok &&
      !!s?.attachments_ok;
    if (schemaReady && !baseApplied) {
      try {
        await sql`INSERT INTO schema_migrations (id) VALUES (${BASE_MIGRATION_ID}) ON CONFLICT (id) DO NOTHING`;
        baseApplied = true;
      } catch {
        void 0;
      }
    }
    if (schemaReady && baseApplied) {
      void 0;
    } else {
      void 0;
    }
  } catch {
    void 0;
  }

  if (!baseApplied) {

  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  } catch {
    void 0;
  }

  if (!postedSourceApplied) {
    try {
      const rows = await sql`
        SELECT
          to_regclass('public.journal_entries') IS NOT NULL AS journals_ok,
          EXISTS(
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'journal_entries' AND column_name = 'posted_source'
          ) AS posted_source_ok
      `;
      const s: any = (rows as any[])?.[0];
      if (s?.journals_ok && !s?.posted_source_ok) {
        await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS posted_source TEXT NOT NULL DEFAULT 'user'`;
      }
      await sql`INSERT INTO schema_migrations (id) VALUES (${JOURNAL_POSTED_SOURCE_MIGRATION_ID}) ON CONFLICT (id) DO NOTHING`;
      postedSourceApplied = true;
    } catch {
      void 0;
    }
  }

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT false`;
  await sql`UPDATE users SET status = 'active' WHERE status IS NULL`;

  await sql`
    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      registration_no TEXT,
      base_currency TEXT NOT NULL,
      industry TEXT NOT NULL DEFAULT 'restaurant',
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS registration_no TEXT`;
  await sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS industry TEXT NOT NULL DEFAULT 'restaurant'`;
  await sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;

  await sql`
    CREATE TABLE IF NOT EXISTS user_default_org (
      user_id UUID PRIMARY KEY,
      org_id UUID NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS memberships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      user_id UUID NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (org_id, user_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)`;
  await sql`ALTER TABLE memberships ADD COLUMN IF NOT EXISTS is_global BOOLEAN NOT NULL DEFAULT false`;

  await sql`UPDATE memberships SET role = 'admin' WHERE role = 'owner'`;

  await sql`
    CREATE TABLE IF NOT EXISTS role_permissions (
      org_id UUID NOT NULL,
      role TEXT NOT NULL,
      permissions TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, role)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_role_permissions_org ON role_permissions(org_id)`;

  try {
    const roles = ["admin", "accountant", "viewer", "auditor"];
    const allPerms = [
      "settings.view",
      "settings.edit",
      "journal.view",
      "journal.edit",
      "inventory.view",
      "inventory.edit",
      "fixedAssets.view",
      "fixedAssets.edit",
      "vendors.view",
      "vendors.edit",
      "customers.view",
      "customers.edit",
      "reports.view",
      "users.manage",
    ];

    const accountantPerms = [
      "settings.view",
      "journal.view",
      "journal.edit",
      "inventory.view",
      "inventory.edit",
      "fixedAssets.view",
      "fixedAssets.edit",
      "vendors.view",
      "vendors.edit",
      "customers.view",
      "customers.edit",
      "reports.view",
    ];

    const viewerPerms = ["journal.view", "vendors.view", "customers.view", "reports.view"];

    await sql`
      INSERT INTO role_permissions (org_id, role, permissions)
      SELECT
        o.id,
        r.role,
        CASE
          WHEN r.role = 'admin' THEN ${sql.array(allPerms)}::text[]
          WHEN r.role = 'accountant' THEN ${sql.array(accountantPerms)}::text[]
          WHEN r.role = 'viewer' THEN ${sql.array(viewerPerms)}::text[]
          WHEN r.role = 'auditor' THEN ${sql.array(viewerPerms)}::text[]
          ELSE ${sql.array(viewerPerms)}::text[]
        END
      FROM organizations o
      CROSS JOIN LATERAL (
        SELECT unnest(${sql.array(roles)}::text[]) AS role
      ) r
      WHERE o.deleted_at IS NULL
      ON CONFLICT (org_id, role) DO NOTHING
    `;
  } catch {
    void 0;
  }

  await sql`
    CREATE TABLE IF NOT EXISTS signup_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      org_name TEXT NOT NULL,
      base_currency TEXT NOT NULL,
      industry TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      user_id UUID,
      reviewed_by UUID,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_signup_requests_status ON signup_requests(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_signup_requests_user ON signup_requests(user_id)`;

  try {
    const raw = String(process.env.SUPERADMIN_EMAILS || process.env.SUPERADMIN_EMAIL || "").trim();
    const emails = raw
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (emails.length) {
      await sql`UPDATE users SET is_superadmin = true, status = 'active' WHERE email = ANY(${sql.array(emails)}::text[])`;
    }
  } catch {
    void 0;
  }

  await sql`
    CREATE TABLE IF NOT EXISTS invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(org_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      normal_balance TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      link_inventory_fifo BOOLEAN NOT NULL DEFAULT false,
      link_fixed_assets BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (org_id, code)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(org_id)`;
  await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS link_inventory_fifo BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS link_fixed_assets BOOLEAN NOT NULL DEFAULT false`;

  await sql`UPDATE accounts SET link_fixed_assets = true WHERE link_fixed_assets = false AND (code LIKE '16%' OR code LIKE '61%')`;
  await sql`UPDATE accounts SET link_inventory_fifo = true WHERE link_inventory_fifo = false AND code = '1500'`;

  const restaurantSeedAccounts = [
    { code: "1000", name: "Cash", type: "asset", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "1100", name: "Bank", type: "asset", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "1200", name: "Accounts Receivable", type: "asset", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "1500", name: "Inventory", type: "asset", normal_balance: "debit", link_inventory_fifo: true, link_fixed_assets: false },
    { code: "1600", name: "Fixed Assets", type: "asset", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: true },
    { code: "1610", name: "Accumulated Depreciation", type: "asset", normal_balance: "credit", link_inventory_fifo: false, link_fixed_assets: true },
    { code: "2000", name: "Accounts Payable", type: "liability", normal_balance: "credit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "2021", name: "Amount due to director", type: "liability", normal_balance: "credit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "3000", name: "Retained Earnings", type: "equity", normal_balance: "credit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "4000", name: "Sales", type: "income", normal_balance: "credit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "5000", name: "Cost of Goods Sold", type: "cogs", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "5010", name: "Food & Beverage Cost", type: "cogs", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "6000", name: "Operating Expenses", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "6020", name: "Rent", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "6030", name: "Utilities", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "6040", name: "Renovation", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "6050", name: "Design Fee", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "6060", name: "Salary", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "6070", name: "Marketing", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "6080", name: "Cleaning", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "6090", name: "POS / Software", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
    { code: "6100", name: "Depreciation Expense", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: true },
    { code: "7000", name: "Gain/Loss on Disposal", type: "expense", normal_balance: "debit", link_inventory_fifo: false, link_fixed_assets: false },
  ];

  try {
    const codes = restaurantSeedAccounts.map((a) => a.code);
    const names = restaurantSeedAccounts.map((a) => a.name);
    const types = restaurantSeedAccounts.map((a) => a.type);
    const normals = restaurantSeedAccounts.map((a) => a.normal_balance);
    const linkInv = restaurantSeedAccounts.map((a) => a.link_inventory_fifo);
    const linkFa = restaurantSeedAccounts.map((a) => a.link_fixed_assets);
    await sql`
      INSERT INTO accounts (org_id, code, name, type, normal_balance, link_inventory_fifo, link_fixed_assets)
      SELECT
        o.id,
        x.code,
        x.name,
        x.type,
        x.normal_balance,
        x.link_inventory_fifo,
        x.link_fixed_assets
      FROM organizations o
      CROSS JOIN LATERAL (
        SELECT
          unnest(${sql.array(codes)}::text[]) AS code,
          unnest(${sql.array(names)}::text[]) AS name,
          unnest(${sql.array(types)}::text[]) AS type,
          unnest(${sql.array(normals)}::text[]) AS normal_balance,
          unnest(${sql.array(linkInv)}::boolean[]) AS link_inventory_fifo,
          unnest(${sql.array(linkFa)}::boolean[]) AS link_fixed_assets
      ) x
      WHERE o.deleted_at IS NULL AND o.industry = 'restaurant'
      ON CONFLICT (org_id, code) DO NOTHING
    `;
  } catch {
    void 0;
  }

  await sql`
    CREATE TABLE IF NOT EXISTS cost_centers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      UNIQUE (org_id, code)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS currencies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      code TEXT NOT NULL,
      is_enabled BOOLEAN NOT NULL DEFAULT true,
      UNIQUE (org_id, code)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS fx_rates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      rate_date DATE NOT NULL,
      currency_code TEXT NOT NULL,
      fx_rate NUMERIC(18,8) NOT NULL,
      UNIQUE (org_id, rate_date, currency_code)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      bank_name TEXT NOT NULL,
      account_no TEXT NOT NULL,
      account_id UUID NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_bank_accounts_org ON bank_accounts(org_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bank_accounts_account ON bank_accounts(org_id, account_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_accounts_org_account_no_unique ON bank_accounts(org_id, account_no)`;

  await sql`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      entry_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      posted_source TEXT NOT NULL DEFAULT 'user',
      voucher_no TEXT,
      parent_entry_id UUID,
      is_system BOOLEAN NOT NULL DEFAULT false,
      currency_code TEXT NOT NULL,
      fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1,
      memo TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      posted_at TIMESTAMPTZ,
      vendor_id UUID,
      customer_id UUID
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_entries_org_date ON journal_entries(org_id, entry_date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_entries_org_date_created ON journal_entries(org_id, entry_date DESC, created_at DESC)`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS inventory_impact BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS posted_source TEXT NOT NULL DEFAULT 'user'`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS voucher_no TEXT`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS parent_entry_id UUID`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS vendor_id UUID`;
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS customer_id UUID`;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_entries_parent ON journal_entries(org_id, parent_entry_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_org_voucher_no_unique ON journal_entries(org_id, voucher_no) WHERE voucher_no IS NOT NULL AND voucher_no <> ''`;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_entries_vendor_id ON journal_entries(org_id, vendor_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_entries_customer_id ON journal_entries(org_id, customer_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS vendors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      code TEXT,
      name TEXT NOT NULL,
      notes TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_vendors_org ON vendors(org_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_org_code_unique ON vendors(org_id, code) WHERE code IS NOT NULL AND code <> ''`;

  await sql`
    CREATE TABLE IF NOT EXISTS customers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      code TEXT,
      name TEXT NOT NULL,
      notes TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_customers_org ON customers(org_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_org_code_unique ON customers(org_id, code) WHERE code IS NOT NULL AND code <> ''`;

  await sql`
    CREATE TABLE IF NOT EXISTS ap_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      vendor_id UUID NOT NULL,
      doc_no TEXT,
      issue_date DATE NOT NULL,
      due_date DATE NOT NULL,
      currency_code TEXT NOT NULL,
      fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1,
      total_txn NUMERIC(18,2) NOT NULL DEFAULT 0,
      paid_txn NUMERIC(18,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      memo TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ap_documents_org_vendor ON ap_documents(org_id, vendor_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ap_documents_org_due ON ap_documents(org_id, due_date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ap_documents_org_status ON ap_documents(org_id, status)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_documents_org_doc_no_unique ON ap_documents(org_id, doc_no) WHERE doc_no IS NOT NULL AND doc_no <> ''`;

  await sql`
    CREATE TABLE IF NOT EXISTS ar_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      customer_id UUID NOT NULL,
      doc_no TEXT,
      issue_date DATE NOT NULL,
      due_date DATE NOT NULL,
      currency_code TEXT NOT NULL,
      fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1,
      total_txn NUMERIC(18,2) NOT NULL DEFAULT 0,
      paid_txn NUMERIC(18,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      memo TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ar_documents_org_customer ON ar_documents(org_id, customer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ar_documents_org_due ON ar_documents(org_id, due_date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ar_documents_org_status ON ar_documents(org_id, status)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ar_documents_org_doc_no_unique ON ar_documents(org_id, doc_no) WHERE doc_no IS NOT NULL AND doc_no <> ''`;

  await sql`
    CREATE TABLE IF NOT EXISTS org_counters (
      org_id UUID NOT NULL,
      key TEXT NOT NULL,
      next_int BIGINT NOT NULL,
      PRIMARY KEY (org_id, key)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS journal_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      entry_id UUID NOT NULL,
      line_no INT NOT NULL,
      account_id UUID NOT NULL,
      description TEXT,
      cost_center_id UUID,
      inventory_item_id UUID,
      fixed_asset_id UUID,
      debit_txn NUMERIC(18,2) NOT NULL DEFAULT 0,
      credit_txn NUMERIC(18,2) NOT NULL DEFAULT 0,
      debit_base NUMERIC(18,2) NOT NULL DEFAULT 0,
      credit_base NUMERIC(18,2) NOT NULL DEFAULT 0
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(org_id, account_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_lines_org_entry ON journal_lines(org_id, entry_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_lines_org_entry_debit ON journal_lines(org_id, entry_id) INCLUDE (debit_txn, debit_base)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_lines_org_fixed_asset ON journal_lines(org_id, fixed_asset_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      entry_id UUID NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INT,
      data_base64 TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`;

  await sql`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      sku TEXT,
      name TEXT NOT NULL,
      uom TEXT NOT NULL DEFAULT 'EA',
      inventory_account_id UUID,
      cogs_account_id UUID,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_inventory_items_org ON inventory_items(org_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_org_sku_unique ON inventory_items(org_id, sku) WHERE sku IS NOT NULL AND sku <> ''`;

  await sql`
    CREATE TABLE IF NOT EXISTS inventory_layers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      item_id UUID NOT NULL,
      received_date DATE NOT NULL,
      qty_remaining NUMERIC(18,4) NOT NULL,
      unit_cost_base NUMERIC(18,6) NOT NULL,
      source_entry_id UUID,
      source_move_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_inventory_layers_item ON inventory_layers(org_id, item_id, received_date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_inventory_layers_available ON inventory_layers(org_id, item_id, received_date, created_at, id) WHERE qty_remaining > 0`;
  await sql`ALTER TABLE inventory_layers ADD COLUMN IF NOT EXISTS source_move_id UUID`;

  await sql`
    CREATE TABLE IF NOT EXISTS error_logs (
      id UUID PRIMARY KEY,
      org_id UUID,
      user_id UUID,
      route TEXT,
      message TEXT,
      stack TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_error_logs_org_created ON error_logs(org_id, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS inventory_moves (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      item_id UUID NOT NULL,
      move_type TEXT NOT NULL,
      move_date DATE NOT NULL,
      qty NUMERIC(18,4) NOT NULL,
      unit_cost_base NUMERIC(18,6),
      unit_cost_txn NUMERIC(18,6),
      currency_code TEXT,
      fx_rate NUMERIC(18,8),
      status TEXT NOT NULL DEFAULT 'posted',
      entry_id UUID,
      entry_line_no INT,
      source_layer_id UUID,
      created_layer_id UUID,
      entry_seq INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE inventory_moves ADD COLUMN IF NOT EXISTS unit_cost_txn NUMERIC(18,6)`;
  await sql`ALTER TABLE inventory_moves ADD COLUMN IF NOT EXISTS currency_code TEXT`;
  await sql`ALTER TABLE inventory_moves ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(18,8)`;
  await sql`ALTER TABLE inventory_moves ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'posted'`;
  await sql`ALTER TABLE inventory_moves ADD COLUMN IF NOT EXISTS entry_line_no INT`;
  await sql`ALTER TABLE inventory_moves ADD COLUMN IF NOT EXISTS source_layer_id UUID`;
  await sql`ALTER TABLE inventory_moves ADD COLUMN IF NOT EXISTS created_layer_id UUID`;
  await sql`ALTER TABLE inventory_moves ADD COLUMN IF NOT EXISTS entry_seq INT`;

  await sql`CREATE INDEX IF NOT EXISTS idx_inventory_moves_item ON inventory_moves(org_id, item_id, move_date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_inventory_moves_entry ON inventory_moves(org_id, entry_id, status, move_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_inventory_moves_entry_seq ON inventory_moves(org_id, entry_id, entry_seq)`;

  await sql`
    CREATE TABLE IF NOT EXISTS fixed_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      asset_no TEXT,
      name TEXT NOT NULL,
      category TEXT,
      acquisition_date DATE NOT NULL,
      cost_base NUMERIC(18,2) NOT NULL,
      useful_life_months INT NOT NULL,
      salvage_value_base NUMERIC(18,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      asset_account_id UUID,
      accum_dep_account_id UUID,
      dep_expense_account_id UUID,
      disposed_at DATE,
      memo TEXT
    )
  `;

  await sql`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS asset_no TEXT`;
  await sql`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS category TEXT`;
  await sql`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS memo TEXT`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_fixed_assets_org_asset_no_unique ON fixed_assets(org_id, asset_no) WHERE asset_no IS NOT NULL AND asset_no <> ''`;

  await sql`
    CREATE TABLE IF NOT EXISTS depreciation_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      period TEXT NOT NULL,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (org_id, period)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS depreciation_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      run_id UUID NOT NULL,
      asset_id UUID NOT NULL,
      amount_base NUMERIC(18,2) NOT NULL,
      entry_id UUID NOT NULL,
      UNIQUE (org_id, asset_id, run_id)
    )
  `;

  try {
    await sql`INSERT INTO schema_migrations (id) VALUES (${BASE_MIGRATION_ID}) ON CONFLICT (id) DO NOTHING`;
    baseApplied = true;
  } catch {
    void 0;
  }

  }

  let fxFixApplied = false;
  try {
    const applied = await sql`SELECT 1 FROM schema_migrations WHERE id = ${FX_FIX_MIGRATION_ID} LIMIT 1`;
    fxFixApplied = Boolean((applied as any[])?.length);
  } catch {
    fxFixApplied = false;
  }

  if (!fxFixApplied) {
    try {
      await sql`
        UPDATE journal_lines l
        SET
          debit_base = ROUND(l.debit_txn / NULLIF(e.fx_rate, 0), 2),
          credit_base = ROUND(l.credit_txn / NULLIF(e.fx_rate, 0), 2)
        FROM journal_entries e
        JOIN organizations o ON o.id = e.org_id
        WHERE l.org_id = e.org_id
          AND l.entry_id = e.id
          AND e.org_id = o.id
          AND UPPER(COALESCE(e.currency_code, '')) <> UPPER(COALESCE(o.base_currency, ''))
          AND COALESCE(e.fx_rate, 0) <> 0
      `;
    } catch {
      void 0;
    }

    try {
      await sql`
        UPDATE inventory_moves m
        SET unit_cost_base = CASE
          WHEN COALESCE(m.fx_rate, 0) = 0 THEN m.unit_cost_txn
          ELSE m.unit_cost_txn / m.fx_rate
        END
        FROM organizations o
        WHERE m.org_id = o.id
          AND UPPER(COALESCE(m.currency_code, '')) <> UPPER(COALESCE(o.base_currency, ''))
          AND m.unit_cost_txn IS NOT NULL
      `;
    } catch {
      void 0;
    }

    try {
      await sql`
        UPDATE inventory_layers l
        SET unit_cost_base = CASE
          WHEN COALESCE(m.fx_rate, 0) = 0 THEN m.unit_cost_txn
          ELSE m.unit_cost_txn / m.fx_rate
        END
        FROM inventory_moves m
        JOIN organizations o ON o.id = m.org_id
        WHERE l.org_id = m.org_id
          AND l.source_move_id = m.id
          AND UPPER(COALESCE(m.currency_code, '')) <> UPPER(COALESCE(o.base_currency, ''))
          AND m.unit_cost_txn IS NOT NULL
      `;
    } catch {
      void 0;
    }

    try {
      await sql`
        WITH purchase AS (
          SELECT DISTINCT ON (l.fixed_asset_id)
            l.org_id as org_id,
            l.fixed_asset_id as asset_id,
            l.debit_txn as cost_txn,
            e.fx_rate as fx_rate,
            e.currency_code as currency_code,
            o.base_currency as base_currency
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id AND e.org_id = l.org_id
          JOIN organizations o ON o.id = l.org_id
          WHERE l.fixed_asset_id IS NOT NULL
            AND e.status = 'posted'
            AND COALESCE(l.debit_txn, 0) > 0
          ORDER BY l.fixed_asset_id, e.entry_date ASC, e.id ASC
        )
        UPDATE fixed_assets a
        SET cost_base = CASE
          WHEN COALESCE(p.fx_rate, 0) = 0 THEN a.cost_base
          ELSE ROUND(p.cost_txn / p.fx_rate, 2)
        END
        FROM purchase p
        WHERE a.org_id = p.org_id
          AND a.id = p.asset_id
          AND UPPER(COALESCE(p.currency_code, '')) <> UPPER(COALESCE(p.base_currency, ''))
      `;
    } catch {
      void 0;
    }

    try {
      await sql`INSERT INTO schema_migrations (id) VALUES (${FX_FIX_MIGRATION_ID}) ON CONFLICT (id) DO NOTHING`;
      fxFixApplied = true;
    } catch {
      void 0;
    }
  }

  let perfIndexesApplied = false;
  try {
    const applied = await sql`SELECT 1 FROM schema_migrations WHERE id = ${PERF_INDEXES_MIGRATION_ID} LIMIT 1`;
    perfIndexesApplied = Boolean((applied as any[])?.length);
  } catch {
    perfIndexesApplied = false;
  }

  if (!perfIndexesApplied) {
    try {
      await sql`
        CREATE INDEX IF NOT EXISTS idx_attachments_org_entry_created
        ON attachments(org_id, entry_id, created_at DESC)
      `;
    } catch {
      void 0;
    }

    try {
      await sql`
        CREATE INDEX IF NOT EXISTS idx_journal_lines_org_entry_line
        ON journal_lines(org_id, entry_id, line_no)
      `;
    } catch {
      void 0;
    }

    try {
      await sql`INSERT INTO schema_migrations (id) VALUES (${PERF_INDEXES_MIGRATION_ID}) ON CONFLICT (id) DO NOTHING`;
      perfIndexesApplied = true;
    } catch {
      void 0;
    }
  }

    migrated = true;
  })().finally(() => {
    migrating = null;
  });
  await migrating;
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
