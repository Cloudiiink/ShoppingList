import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { appConfigDir, join } from "@tauri-apps/api/path";
import { writeTextFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSite, deleteSite, listSites, updateSite, siteRefCount } from "@/db/sites";
import { listOrders } from "@/db/orders";
import { listBatches } from "@/db/batches";
import { listRates, upsertRate, type RateRow } from "@/db/rates";
import { refreshAllRates } from "@/lib/rates";
import { ordersToCsv } from "@/db/export";
import { doBackup, listBackups } from "@/lib/backupFiles";
import type { ImportMode } from "@/lib/importDb";
import { isoToLocalDateTime } from "@/lib/time";
import { CURRENCIES, type Currency, type SiteRow, type SqlDb } from "@/db/types";
import { useHelpIcons } from "@/lib/helpIcons";
import { HelpIcon } from "@/components/HelpIcon";
import { useConfirm } from "@/components/ConfirmDialog";

export function SettingsPage({ db, onSitesChanged, onSwitchDatabase }: {
  db: SqlDb;
  onSitesChanged: (sites: SiteRow[]) => void;
  onSwitchDatabase: (file: File, mode: ImportMode) => Promise<void>;
}) {
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
  const [rates, setRates] = useState<RateRow[]>([]);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("replace");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { showHelp, setShowHelp } = useHelpIcons();
  const confirm = useConfirm();

  const reload = useCallback(async () => {
    const ss = await listSites(db);
    setSites(ss);
    onSitesChanged(ss);
    const counts: Record<number, number> = {};
    for (const s of ss) counts[s.id] = await siteRefCount(db, s.id);
    setRefCounts(counts);
    setBackups(await listBackups());
    setDbPath(await join(await appConfigDir(), "tracker.db"));
    const rs = await listRates(db);
    setRates(rs);
    setRateDrafts(Object.fromEntries(rs.map((r) => [r.currency, String(r.rate)])));
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
      setMessage(`已导出 ${orders.length} 条订单：${await join(await appConfigDir(), name)}`);
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

  async function saveRate(c: Currency) {
    setError(""); setMessage("");
    try {
      const v = Number(rateDrafts[c]);
      await upsertRate(db, c, v);
      setMessage(`${c} 汇率已保存：${v}`);
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function refreshRates() {
    setError(""); setMessage("");
    setRefreshing(true);
    try {
      await refreshAllRates(db);
      setMessage("汇率已全部刷新");
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRefreshing(false); }
  }

  function pickFile(mode: ImportMode) {
    setImportMode(mode);
    fileInputRef.current?.click();
  }

  async function onReplaceClick() {
    if (!(await confirm({
      title: "替换当前数据库？",
      body: "将先自动备份当前数据，再用所选 .db 覆盖并重新加载（下次启动继续用）。此操作不可撤销，请确认已备份重要数据。",
      confirmText: "选择文件并替换",
      danger: true,
    }))) return;
    pickFile("replace");
  }

  async function onFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许再次选择同一文件
    if (!file) return;
    setError(""); setMessage("");
    try {
      await onSwitchDatabase(file, importMode);
      setMessage(importMode === "replace"
        ? "数据库已替换并重新加载"
        : "已临时加载数据库（重启后恢复默认）");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="max-w-3xl space-y-6 p-4">
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-destructive">{error}</div>}
      {message && <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{message}</div>}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">显示</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showHelp}
            onChange={(e) => setShowHelp(e.target.checked)}
          />
          显示页面上的帮助图标（悬停查看说明）
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">网站管理</h2>
        {sites.length === 0 && (
          <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            还没有网站。先添加常用网站（如 JAYD 澳洲站），录单和开团都需要它。
          </p>
        )}
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

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">汇率维护<HelpIcon text="这里的汇率只用于订单页预估买入价；团结算的权威汇率在团页手填。" className="ml-1" /></h2>
          <Button size="sm" variant="outline" onClick={refreshRates} disabled={refreshing}>
            {refreshing ? "刷新中…" : "全部刷新"}
          </Button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {CURRENCIES.map((c) => {
              const row = rates.find((r) => r.currency === c);
              return (
                <tr key={c} className="border-b">
                  <td className="w-20 p-2 font-medium">{c}</td>
                  <td className="w-40 p-2">
                    <Input
                      value={rateDrafts[c] ?? ""}
                      placeholder="未设置"
                      onChange={(e) => setRateDrafts((d) => ({ ...d, [c]: e.target.value }))}
                    />
                  </td>
                  <td className="p-2 text-muted-foreground">
                    {row ? `更新于 ${isoToLocalDateTime(row.updated_at)}` : "未设置"}
                  </td>
                  <td className="w-24 p-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!(Number(rateDrafts[c]) > 0)}
                      onClick={() => saveRate(c)}
                    >
                      保存
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="text-sm text-muted-foreground">
          新建订单选币种后自动预填此汇率（仅订单层预估；团结算权威汇率仍在团页手填）。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">导出</h2>
        <Button variant="outline" onClick={exportCsv}>导出全部订单 CSV</Button>
        <p className="text-sm text-muted-foreground">金额导出为「元」两位小数，adjustments 展开为 JSON 字符串。</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">备份<HelpIcon text="只防误删误改，不防丢电脑/硬盘；建议定期把备份拷到 iCloud 或移动硬盘。" className="ml-1" /></h2>
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
        <h2 className="text-lg font-semibold">数据库<HelpIcon text="导入备份或从另一台电脑迁移数据：选一个 .db 文件。替换＝覆盖当前数据（自动先备份）；临时加载＝只本次使用，重启恢复默认。" className="ml-1" /></h2>
        <p className="font-mono text-sm text-muted-foreground">{dbPath}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onReplaceClick}>导入数据库（替换）</Button>
          <Button variant="outline" onClick={() => pickFile("preview")}>临时加载数据库…</Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={onFileChosen}
        />
      </section>
    </div>
  );
}
