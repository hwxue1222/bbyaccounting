import { create } from "zustand";
import { api } from "@/lib/api";

export type OrgRow = {
  orgId: string;
  orgName: string;
  baseCurrency: string;
  role: string;
};

type AuthState = {
  status: "idle" | "loading" | "authed" | "anon";
  user: { id: string; email: string } | null;
  orgs: OrgRow[];
  activeOrgId: string | null;
  error: string | null;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, orgName: string, baseCurrency: string) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  createOrg: (name: string, baseCurrency: string) => Promise<void>;
  acceptInvite: (token: string, password: string) => Promise<void>;
  createInvite: (email: string, role: string) => Promise<{ inviteUrl: string }>
};

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "idle",
  user: null,
  orgs: [],
  activeOrgId: null,
  error: null,
  bootstrap: async () => {
    set({ status: "loading", error: null });
    try {
      const me = await api<{ user: { id: string; email: string }; orgId: string | null }>("/api/auth/me");
      const orgsResp = await api<{ orgs: OrgRow[]; activeOrgId: string | null }>("/api/orgs");
      set({ status: "authed", user: me.user, activeOrgId: me.orgId, orgs: orgsResp.orgs, error: null });
    } catch (_e: any) {
      set({ status: "anon", user: null, activeOrgId: null, orgs: [], error: null });
    }
  },
  login: async (email, password) => {
    set({ status: "loading", error: null });
    try {
      const resp = await api<{ user: { id: string; email: string }; orgId: string | null }>("/api/auth/login", {
        method: "POST",
        json: { email, password },
      });
      const orgsResp = await api<{ orgs: OrgRow[]; activeOrgId: string | null }>("/api/orgs");
      set({ status: "authed", user: resp.user, activeOrgId: resp.orgId, orgs: orgsResp.orgs, error: null });
    } catch (e: any) {
      set({ status: "anon", error: e?.message || "登录失败" });
    }
  },
  register: async (email, password, orgName, baseCurrency) => {
    set({ status: "loading", error: null });
    try {
      const resp = await api<{ user: { id: string; email: string }; org: { id: string } }>("/api/auth/register", {
        method: "POST",
        json: { email, password, orgName, baseCurrency },
      });
      const orgsResp = await api<{ orgs: OrgRow[]; activeOrgId: string | null }>("/api/orgs");
      set({ status: "authed", user: resp.user, activeOrgId: resp.org.id, orgs: orgsResp.orgs, error: null });
    } catch (e: any) {
      set({ status: "anon", error: e?.message || "注册失败" });
    }
  },
  logout: async () => {
    await api("/api/auth/logout", { method: "POST" });
    set({ status: "anon", user: null, orgs: [], activeOrgId: null });
  },
  switchOrg: async (orgId: string) => {
    await api("/api/orgs/switch", { method: "POST", json: { orgId } });
    await get().bootstrap();
  },
  createOrg: async (name: string, baseCurrency: string) => {
    await api("/api/orgs/create", { method: "POST", json: { name, baseCurrency } });
    await get().bootstrap();
  },
  acceptInvite: async (token: string, password: string) => {
    set({ status: "loading", error: null });
    try {
      await api("/api/auth/accept-invite", { method: "POST", json: { token, password } });
      await get().bootstrap();
    } catch (e: any) {
      set({ status: "anon", error: e?.message || "接受邀请失败" });
    }
  },
  createInvite: async (email: string, role: string) => {
    const resp = await api<{ inviteUrl: string }>("/api/auth/create-invite", {
      method: "POST",
      json: { email, role },
    });
    return { inviteUrl: resp.inviteUrl };
  },
}));
