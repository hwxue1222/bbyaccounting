export const ALLOWED_ROLE_PERMS = new Set([
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
]);

export const ROLE_ORDER = ["admin", "accountant", "viewer", "auditor"] as const;

export function defaultPermissionsForRole(role: string): string[] {
  const all = [
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
  const accountant = [
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
  const viewer = ["journal.view", "vendors.view", "customers.view", "reports.view"];

  if (role === "admin") return all;
  if (role === "accountant") return accountant;
  if (role === "viewer" || role === "auditor") return viewer;
  return viewer;
}

