export type Role = "admin" | "accountant" | "viewer" | "auditor";

export function roleAtLeast(role: Role, min: Role): boolean {
  const rank: Record<Role, number> = {
    admin: 40,
    accountant: 30,
    auditor: 20,
    viewer: 10,
  };
  return rank[role] >= rank[min];
}
