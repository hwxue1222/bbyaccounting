import { create } from "zustand";
import { api } from "@/lib/api";

export type OrgRow = {
  orgId: string;
  orgName: string;
  registrationNo?: string | null;
  baseCurrency: string;
  role: string;
};

type AuthState = {
  status: "idle" | "loading" | "authed" | "anon";
  user: { id: string; email: string } | null;
  orgs: OrgRow[];
  activeOrgId: string | null;
  pendingOrgId: string | null;
  orgSwitching: boolean;
  error: string | null;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, orgName: string, baseCurrency: string) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  createOrg: (name: string, baseCurrency: string) => Promise<void>;
  updateOrg: (orgId: string, name: string, registrationNo: string | null) => Promise<void>;
  acceptInvite: (token: string, password: string) => Promise<void>;
  createInvite: (email: string, role: string) => Promise<{ inviteUrl: string }>
};

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "idle",
  user: null,
  orgs: [],
  activeOrgId: null,
  pendingOrgId: null,
  orgSwitching: false,
  error: null,
  bootstrap: async () => {
    set({ status: "loading", error: null });
    try {
      const [me, orgsResp] = await Promise.all([
        api<{ user: { id: string; email: string }; orgId: string | null }>("/api/auth/me"),
        api<{ orgs: OrgRow[]; activeOrgId: string | null }>("/api/orgs"),
      ]);

      set({
        status: "authed",
        user: me.user,
        activeOrgId: orgsResp.activeOrgId ?? me.orgId,
        orgs: orgsResp.orgs,
        error: null,
      });
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
    const cur = get().activeOrgId;
    if (cur === orgId) return;
    set({ orgSwitching: true, pendingOrgId: orgId });
    try {
      await api("/api/orgs/switch", { method: "POST", json: { orgId } });
      set({ activeOrgId: orgId, pendingOrgId: null, orgSwitching: false, error: null });
    } catch (e: any) {
      set({ pendingOrgId: null, orgSwitching: false, error: e?.message || "切换公司失败" });
    }
  },
  createOrg: async (name: string, baseCurrency: string) => {
    await api("/api/orgs/create", { method: "POST", json: { name, baseCurrency } });
    const orgsResp = await api<{ orgs: OrgRow[]; activeOrgId: string | null }>("/api/orgs");
    set({ orgs: orgsResp.orgs, activeOrgId: orgsResp.activeOrgId });
  },
  updateOrg: async (orgId: string, name: string, registrationNo: string | null) => {
    const resp = await api<{ org: OrgRow }>("/api/orgs/update", {
      method: "POST",
      json: { orgId, name, registrationNo },
    });
    set({
      orgs: get().orgs.map((o) => (o.orgId === orgId ? { ...o, orgName: resp.org.orgName, registrationNo: resp.org.registrationNo } : o)),
    });
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
