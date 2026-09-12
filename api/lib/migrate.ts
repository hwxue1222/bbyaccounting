import crypto from "crypto";
import { getSql } from "./db.js";

let migrated = false;

export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  const sql = getSql();

  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  } catch {
    // ignore
  }

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      registration_no TEXT,
      base_currency TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS registration_no TEXT`;

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
  await sql`ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS inventory_impact BOOLEAN NOT NULL DEFAULT false`;
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

  await sql`
    CREATE TABLE IF NOT EXISTS attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      entry_id UUID NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INT,
      data_base64 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

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

  migrated = true;
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
