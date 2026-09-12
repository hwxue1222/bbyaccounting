import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

type PartyRow = {
  id: string;
  code: string | null;
  name: string;
  isActive: boolean;
};

export default function PartyList(props: {
  title: string;
  listEndpoint: string;
  listKey: "vendors" | "customers";
  createEndpoint: string;
  patchEndpointPrefix: string;
}) {
  const tr = useTr();
  const { activeOrgId, orgSwitching } = useAuthStore();

  const [rows, setRows] = useState<PartyRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingCode, setEditingCode] = useState("");
  const [editingName, setEditingName] = useState("");

  async function refresh() {
    const r = await api<any>(props.listEndpoint);
    setRows(((r?.[props.listKey] || []) as any[]) as PartyRow[]);
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setBusy(true);
    refresh()
      .catch((e: any) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [activeOrgId, orgSwitching]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((v) => {
      const code = (v.code || "").toLowerCase();
      const name = (v.name || "").toLowerCase();
      return code.includes(q) || name.includes(q);
    });
  }, [rows, search]);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="text-sm font-semibold">{props.title}</div>
        <div>
          <label className="text-xs text-zinc-600">{tr("搜索", "Search")}</label>
          <input className="mt-1 w-56 rounded-md border border-zinc-200 px-3 py-2 text-sm" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="text-xs text-zinc-600">{tr("编号（可选）", "Code (optional)")}</label>
          <input className="mt-1 w-44 rounded-md border border-zinc-200 px-3 py-2 text-sm" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())} />
        </div>
        <div>
          <label className="text-xs text-zinc-600">{tr("名称", "Name")}</label>
          <input className="mt-1 w-72 rounded-md border border-zinc-200 px-3 py-2 text-sm" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <button
          className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
          disabled={busy || !newName.trim()}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await api(props.createEndpoint, { method: "POST", json: { code: newCode.trim() || undefined, name: newName.trim() } });
              setNewCode("");
              setNewName("");
              await refresh();
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
          type="button"
        >
          {tr("新增", "Add")}
        </button>
      </div>

      {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

      <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
            <tr>
              <th className="px-3 py-2 text-left">{tr("编号", "Code")}</th>
              <th className="px-3 py-2 text-left">{tr("名称", "Name")}</th>
              <th className="px-3 py-2 text-left">{tr("状态", "Status")}</th>
              <th className="px-3 py-2 text-right">{tr("操作", "Action")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((v) => {
              const isEditing = editingId === v.id;
              return (
                <tr key={v.id} className="border-t border-zinc-100">
                  <td className="px-3 py-2">
                    {isEditing ? (
                      <input className="w-36 rounded-md border border-zinc-200 px-2 py-1 text-sm" value={editingCode} onChange={(e) => setEditingCode(e.target.value.toUpperCase())} />
                    ) : (
                      v.code || "-"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {isEditing ? (
                      <input className="w-full rounded-md border border-zinc-200 px-2 py-1 text-sm" value={editingName} onChange={(e) => setEditingName(e.target.value)} />
                    ) : (
                      v.name
                    )}
                  </td>
                  <td className="px-3 py-2">{v.isActive ? tr("启用", "Active") : tr("停用", "Inactive")}</td>
                  <td className="px-3 py-2 text-right">
                    {isEditing ? (
                      <div className="flex justify-end gap-2">
                        <button
                          className="rounded-md bg-blue-700 px-2 py-1 text-xs text-white hover:bg-blue-800 disabled:opacity-50"
                          disabled={busy || !editingName.trim()}
                          onClick={async () => {
                            setBusy(true);
                            setErr(null);
                            try {
                              await api(`${props.patchEndpointPrefix}${encodeURIComponent(v.id)}` as any, {
                                method: "PATCH",
                                json: { code: editingCode.trim() || undefined, name: editingName.trim() },
                              });
                              setEditingId(null);
                              await refresh();
                            } catch (e: any) {
                              setErr(e.message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                          type="button"
                        >
                          {tr("保存", "Save")}
                        </button>
                        <button
                          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                          onClick={() => setEditingId(null)}
                          type="button"
                        >
                          {tr("取消", "Cancel")}
                        </button>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <button
                          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                          onClick={() => {
                            setEditingId(v.id);
                            setEditingCode((v.code || "").toUpperCase());
                            setEditingName(v.name);
                          }}
                          type="button"
                        >
                          {tr("编辑", "Edit")}
                        </button>
                        <button
                          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            setErr(null);
                            try {
                              await api(`${props.patchEndpointPrefix}${encodeURIComponent(v.id)}` as any, {
                                method: "PATCH",
                                json: { isActive: !v.isActive },
                              });
                              await refresh();
                            } catch (e: any) {
                              setErr(e.message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                          type="button"
                        >
                          {v.isActive ? tr("停用", "Disable") : tr("启用", "Enable")}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!filtered.length ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-zinc-500" colSpan={4}>
                  {busy ? tr("加载中...", "Loading...") : tr("暂无数据", "No data")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

