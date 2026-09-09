export type Role = "owner" | "admin" | "accountant" | "viewer" | "auditor";

export function roleAtLeast(role: Role, min: Role): boolean {
  const rank: Record<Role, number> = {
    owner: 50,
    admin: 40,
    accountant: 30,
    auditor: 20,
    viewer: 10,
  };
  return rank[role] >= rank[min];
}

