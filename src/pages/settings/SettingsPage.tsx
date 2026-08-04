import { useCallback, useEffect, useState } from "react";
import { appConfigDir } from "@tauri-apps/api/path";
import { writeTextFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSite, deleteSite, listSites, updateSite, siteRefCount } from "@/db/sites";
import { listOrders } from "@/db/orders";
import { listBatches } from "@/db/batches";
import { ordersToCsv } from "@/db/export";
import { doBackup, listBackups } from "@/lib/backupFiles";
import type { SiteRow, SqlDb } from "@/db/types";

export function SettingsPage({ db, onSitesChanged }: { db: SqlDb; onSitesChanged: (sites: SiteRow[]) => void }) {
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [refCounts, setRefCounts] = useState<Record<number, number>>({});
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#2563eb");
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [backups, setBackups] = useState<string[]>([]);
  const [dbPath, setDbPath] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const ss = await listSites(db);
    setSites(ss);
    onSitesChanged(ss);
    const counts: Record<number, number> = {};
    for (const s of ss) counts[s.id] = await siteRefCount(db, s.id);
    setRefCounts(counts);
    setBackups(await listBackups());
    setDbPath(`${await appConfigDir()}tracker.db`);
  }, [db, onSitesChanged]);

  useEffect(() => {
    reload().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  async function addSite() {
    setError("");
    try {
      await createSite(db, newName.trim(), newColor);
      setNewName("");
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function saveEdit(id: number) {
    setError("");
    try {
      await updateSite(db, id, { name: editName.trim(), color: editColor });
      setEditId(null);
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function removeSite(s: SiteRow) {
    setError("");
    try {
      await deleteSite(db, s.id);
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function exportCsv() {
    setError(""); setMessage("");
    try {
      const [orders, batches] = await Promise.all([listOrders(db), listBatches(db)]);
      const csv = ordersToCsv(orders, new Map(batches.map((b) => [b.id, b.name])));
      const name = `orders-export-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv`;
      await writeTextFile(name, "﻿" + csv, { baseDir: BaseDirectory.AppConfig });
      setMessage(`已导出 ${orders.length} 条订单：${await appConfigDir()}${name}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function backup() {
    setError(""); setMessage("");
    try {
      const name = await doBackup(db);
      setMessage(`备份完成：${name}（保留最新 2 份）`);
      setBackups(await listBackups());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="max-w-3xl space-y-6 p-4">
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-destructive">{error}</div>}
      {message && <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{message}</div>}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">网站管理</h2>
        <table className="w-full text-sm">
          <tbody>
            {sites.map((s) => (
              <tr key={s.id} className="border-b">
                {editId === s.id ? (
                  <>
                    <td className="p-2"><Input value={editName} onChange={(e) => setEditName(e.target.value)} /></td>
                    <td className="p-2 w-24"><Input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)} /></td>
                    <td className="p-2 w-40">
                      <Button size="sm" onClick={() => saveEdit(s.id)}>保存</Button>{" "}
                      <Button size="sm" variant="ghost" onClick={() => setEditId(null)}>取消</Button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="p-2">
                      <span className="mr-2 inline-block h-3 w-3 rounded-full" style={{ background: s.color ?? "#999" }} />
                      {s.name}
                    </td>
                    <td className="p-2 text-muted-foreground">引用 {refCounts[s.id] ?? 0}</td>
                    <td className="p-2 w-40">
                      <Button size="sm" variant="outline" onClick={() => { setEditId(s.id); setEditName(s.name); setEditColor(s.color ?? "#2563eb"); }}>编辑</Button>{" "}
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => removeSite(s)}>删除</Button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-end gap-2">
          <div><Label>新网站名</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
          <div><Label>颜色</Label><Input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="w-16" /></div>
          <Button onClick={addSite} disabled={!newName.trim()}>添加</Button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">导出</h2>
        <Button variant="outline" onClick={exportCsv}>导出全部订单 CSV</Button>
        <p className="text-sm text-muted-foreground">金额导出为「元」两位小数，adjustments 展开为 JSON 字符串。</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">备份</h2>
        <Button variant="outline" onClick={backup}>立即备份</Button>
        <p className="text-sm text-muted-foreground">
          快照与数据库同目录，保留最新 2 份。只防误操作，建议定期把备份拷到 iCloud/移动硬盘。
        </p>
        <ul className="text-sm text-muted-foreground">
          {backups.map((b) => <li key={b}>{b}</li>)}
          {backups.length === 0 && <li>暂无备份</li>}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">数据库位置</h2>
        <p className="font-mono text-sm text-muted-foreground">{dbPath}</p>
      </section>
    </div>
  );
}
