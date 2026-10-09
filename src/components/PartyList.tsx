import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";
import Button from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import Input from "@/components/ui/Input";
import Label from "@/components/ui/Label";
import { Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/Table";
import Pagination from "@/components/ui/Pagination";

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
  const [page, setPage] = useState(1);
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

  useEffect(() => {
    setPage(1);
  }, [search]);

  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="text-sm font-semibold">{props.title}</div>
        <div>
          <Label>{tr("搜索", "Search")}</Label>
          <Input className="mt-1 w-56" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <Label>{tr("编号（可选）", "Code (optional)")}</Label>
          <Input className="mt-1 w-44" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())} />
        </div>
        <div>
          <Label>{tr("名称", "Name")}</Label>
          <Input className="mt-1 w-72" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <Button
          variant="primary"
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
        </Button>
      </div>

      {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

      <TableWrap className="mt-3">
        <Table>
          <THead>
            <tr>
              <TH>{tr("编号", "Code")}</TH>
              <TH>{tr("名称", "Name")}</TH>
              <TH>{tr("状态", "Status")}</TH>
              <TH className="text-right">{tr("操作", "Action")}</TH>
            </tr>
          </THead>
          <tbody>
            {pageRows.map((v) => {
              const isEditing = editingId === v.id;
              return (
                <TR key={v.id}>
                  <TD>
                    {isEditing ? (
                      <Input className="w-36 px-2 py-1" value={editingCode} onChange={(e) => setEditingCode(e.target.value.toUpperCase())} />
                    ) : (
                      v.code || "-"
                    )}
                  </TD>
                  <TD>
                    {isEditing ? (
                      <Input className="w-full px-2 py-1" value={editingName} onChange={(e) => setEditingName(e.target.value)} />
                    ) : (
                      v.name
                    )}
                  </TD>
                  <TD>{v.isActive ? tr("启用", "Active") : tr("停用", "Inactive")}</TD>
                  <TD className="text-right">
                    {isEditing ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="primary"
                          size="sm"
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
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => setEditingId(null)}
                          type="button"
                        >
                          {tr("取消", "Cancel")}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            setEditingId(v.id);
                            setEditingCode((v.code || "").toUpperCase());
                            setEditingName(v.name);
                          }}
                          type="button"
                        >
                          {tr("编辑", "Edit")}
                        </Button>
                        <Button
                          size="sm"
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
                        </Button>
                      </div>
                    )}
                  </TD>
                </TR>
              );
            })}
            {!pageRows.length ? (
              <TR>
                <TD className="py-8 text-center text-sm text-zinc-500" colSpan={4}>
                  {busy ? tr("加载中...", "Loading...") : tr("暂无数据", "No data")}
                </TD>
              </TR>
            ) : null}
          </tbody>
        </Table>
      </TableWrap>

      <Pagination className="mt-3" page={safePage} pageCount={pageCount} onPage={setPage} />
    </Card>
  );
}
