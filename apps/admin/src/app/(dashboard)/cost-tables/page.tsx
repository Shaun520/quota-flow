"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createCostRule,
  deleteCostRule,
  deleteCostRules,
  exportCostRules,
  listCostRules,
  listProviderOptions,
  updateCostRule,
  upsertCostRules,
  type AdminCostRule,
  type CostRuleInput,
  type ProviderOption
} from "@/lib/api/cost-tables";
import { Pagination } from "@/components/users/pagination";
import { isSupabaseConfigured } from "@/lib/supabase/env";

const PAGE_SIZE = 20;
const MAX_IMPORT_ROWS = 5000;

const MODE_OPTIONS = [
  { value: "text2video", label: "文生视频" },
  { value: "img2video", label: "图生视频" },
  { value: "video2video", label: "视频转视频" },
  { value: "imgs2video", label: "多图生视频" },
  { value: "t2v", label: "文生视频（t2v）" },
  { value: "img", label: "图生视频（img）" },
  { value: "multi_ref", label: "多参考生成" },
  { value: "first_last", label: "首尾帧生成" },
  { value: "first_frame", label: "首帧生成" }
];

export default function CostTablesPage() {
  const [items, setItems] = useState<AdminCostRule[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [providerId, setProviderId] = useState("");
  const [mode, setMode] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([]);
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; item: AdminCostRule } | null>(null);
  const [deleting, setDeleting] = useState<AdminCostRule | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const currentPageIds = items.map((item) => item.id);
  const allCurrentPageSelected =
    currentPageIds.length > 0 && currentPageIds.every((id) => selectedIds.includes(id));

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch((prev) => {
        if (prev === search) return prev;
        setPage(1);
        return search;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listCostRules({
        search: debouncedSearch,
        providerId: providerId || undefined,
        mode: mode || undefined,
        page,
        pageSize: PAGE_SIZE
      });
      setItems(result.items);
      setTotal(result.total);
      setProviderOptions((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const extra = result.items
          .filter((item) => !seen.has(item.provider_id))
          .map((item) => ({ id: item.provider_id, name: item.provider_id }));
        return extra.length > 0 ? [...prev, ...extra] : prev;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, providerId, mode, page]);

  useEffect(() => {
    let cancelled = false;
    async function loadProviders() {
      try {
        const options = await listProviderOptions();
        if (!cancelled) setProviderOptions(options);
      } catch {
        if (!cancelled) setToast("厂商选项加载失败，可直接输入厂商 ID");
      }
    }
    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSelectedIds([]);
  }, [debouncedSearch, providerId, mode, page]);

  useEffect(() => {
    const visible = new Set(items.map((item) => item.id));
    setSelectedIds((prev) => {
      const next = prev.filter((id) => visible.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [items]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function handleSave(input: CostRuleInput) {
    try {
      if (editor?.mode === "edit") {
        await updateCostRule(editor.item.id, input);
        setToast("规则已更新");
      } else {
        await createCostRule(input);
        setToast("规则已创建");
      }
      setEditor(null);
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
    }
  }

  async function handleDelete(item: AdminCostRule) {
    try {
      await deleteCostRule(item.id, item.display_text);
      setDeleting(null);
      setToast("规则已删除");
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
      setDeleting(null);
    }
  }

  function handleToggleSelect(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((selectedId) => selectedId !== id) : [...prev, id]
    );
  }

  function handleToggleSelectAll() {
    setSelectedIds((prev) => {
      const allSelected = currentPageIds.length > 0 && currentPageIds.every((id) => prev.includes(id));
      if (allSelected) {
        return prev.filter((id) => !currentPageIds.includes(id));
      }
      return Array.from(new Set([...prev, ...currentPageIds]));
    });
  }

  async function handleBatchDelete() {
    if (selectedIds.length === 0) return;

    setBatchDeleting(true);
    try {
      const deleted = await deleteCostRules(selectedIds);
      setBatchDeleteOpen(false);
      setSelectedIds([]);
      setToast(`已删除 ${deleted} 条规则`);
      void load();
    } catch (e) {
      setBatchDeleteOpen(false);
      setToast(e instanceof Error ? e.message : "批量删除失败");
    } finally {
      setBatchDeleting(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const rules = await exportCostRules({
        search: debouncedSearch,
        providerId: providerId || undefined,
        mode: mode || undefined
      });
      downloadJson("cost-rules.json", {
        version: 1,
        exported_at: new Date().toISOString(),
        count: rules.length,
        rules: rules.map(toExportRule)
      });
      setToast(`已导出 ${rules.length} 条规则`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      const rules = parseImportFile(text);
      if (rules.length === 0) throw new Error("JSON 中没有可导入的规则");
      const count = await upsertCostRules(rules);
      setToast(`已导入 ${count} 条规则`);
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "导入失败");
    } finally {
      setImporting(false);
      event.target.value = "";
    }
  }

  if (!isSupabaseConfigured()) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">额度扣减规则</h1>
            <p className="page-subtitle">请先配置 NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY。</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">额度扣减规则</h1>
          <p className="page-subtitle">配置不同厂商按生成模式、时长和分辨率应扣除的额度</p>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {exporting ? "导出中..." : "导出 JSON"}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {importing ? "导入中..." : "导入 JSON"}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setEditor({ mode: "create" })}>
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            新增规则
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => void handleImportFile(e)}
          />
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">搜索</span>
          <input
            className="form-input"
            type="search"
            placeholder="模式 / 显示文本"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <span className="filter-label">厂商</span>
          <select
            className="form-select"
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部厂商</option>
            {providerOptions.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}（{provider.id}）
              </option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <span className="filter-label">模式</span>
          <select
            className="form-select"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部模式</option>
            {MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ paddingTop: "var(--space-3)" }}>
          {loading ? (
            <CostRulesSkeleton />
          ) : error ? (
            <div className="empty-state">
              <h3>加载失败</h3>
              <p>{error}</p>
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              <h3>暂无扣减规则</h3>
              <p>点击右上角“新增规则”配置第一条额度规则。</p>
            </div>
          ) : (
            <div>
              <div className="cost-table-toolbar">
                <div className="toolbar-left">
                  <span className="text-muted">
                    {selectedIds.length > 0 ? `已选择 ${selectedIds.length} 条` : `当前页 ${items.length} 条`}
                  </span>
                  {selectedIds.length > 0 ? (
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => setBatchDeleteOpen(true)}
                      disabled={batchDeleting}
                    >
                      <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                      {batchDeleting ? "删除中..." : "批量删除"}
                    </button>
                  ) : null}
                </div>
                {selectedIds.length > 0 ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setSelectedIds([])}
                    disabled={batchDeleting}
                  >
                    取消选择
                  </button>
                ) : null}
              </div>
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>
                        <input
                          type="checkbox"
                          checked={allCurrentPageSelected}
                          onChange={handleToggleSelectAll}
                          disabled={batchDeleting}
                          aria-label="全选当前页"
                        />
                      </th>
                      <th>厂商</th>
                      <th>模式</th>
                      <th>时长区间</th>
                      <th>分辨率</th>
                      <th>模型</th>
                      <th>单位成本</th>
                      <th>等效除数</th>
                      <th>显示文本</th>
                      <th style={{ textAlign: "right" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.id}
                        style={selectedIds.includes(item.id) ? { background: "var(--color-muted)" } : undefined}
                      >
                        <td style={{ width: 40 }}>
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(item.id)}
                            onChange={() => handleToggleSelect(item.id)}
                            disabled={batchDeleting}
                            aria-label={`选择 ${item.provider_id} / ${modeLabel(item.mode)}`}
                          />
                        </td>
                        <td>
                          <span className="badge badge-info">{item.provider_id}</span>
                        </td>
                        <td>{modeLabel(item.mode)}</td>
                        <td className="cell-mono">{formatDurationRange(item.duration_min, item.duration_max)}</td>
                        <td>{item.resolution ?? "—"}</td>
                        <td>{item.model ?? "—"}</td>
                        <td className="cell-mono">{item.unit_cost}</td>
                        <td className="cell-mono">{item.equivalent_count_divisor}</td>
                        <td>
                          <div style={{ maxWidth: 320, whiteSpace: "normal" }}>
                            {item.display_text ?? "—"}
                          </div>
                        </td>
                        <td>
                          <div className="cell-actions" style={{ justifyContent: "flex-end" }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => setEditor({ mode: "edit", item })}>
                              编辑
                            </button>
                            <button className="btn btn-danger btn-sm" onClick={() => setDeleting(item)}>
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </div>

      <div className="alert alert-info" style={{ marginTop: "var(--space-4)" }}>
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <div>
          <strong>生效方式：</strong>规则保存后，桌面端会在下次拉取消耗表缓存时生效。
        </div>
      </div>

      {editor ? (
        <RuleEditorModal
          item={editor.mode === "edit" ? editor.item : null}
          providerOptions={providerOptions}
          onClose={() => setEditor(null)}
          onSave={(input) => handleSave(input)}
        />
      ) : null}

      {deleting ? (
        <DeleteRuleModal
          item={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void handleDelete(deleting)}
        />
      ) : null}

      {batchDeleteOpen ? (
        <BatchDeleteModal
          count={selectedIds.length}
          busy={batchDeleting}
          onCancel={() => setBatchDeleteOpen(false)}
          onConfirm={() => void handleBatchDelete()}
        />
      ) : null}

      {toast ? (
        <div className="toast-container">
          <div className="toast toast-info">
            <div className="toast-content">
              <div className="toast-message">{toast}</div>
            </div>
            <button className="toast-close" onClick={() => setToast(null)} aria-label="关闭">
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CostRulesSkeleton() {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} style={{ height: 64, borderRadius: 8, background: "var(--color-muted)", opacity: 0.5 }} />
      ))}
    </div>
  );
}

function RuleEditorModal({
  item,
  providerOptions,
  onClose,
  onSave
}: {
  item: AdminCostRule | null;
  providerOptions: ProviderOption[];
  onClose: () => void;
  onSave: (input: CostRuleInput) => Promise<void>;
}) {
  const [providerId, setProviderId] = useState(item?.provider_id ?? providerOptions[0]?.id ?? "");
  const [mode, setMode] = useState(item?.mode ?? "text2video");
  const [durationMin, setDurationMin] = useState(item?.duration_min == null ? "" : String(item.duration_min));
  const [durationMax, setDurationMax] = useState(item?.duration_max == null ? "" : String(item.duration_max));
  const [resolution, setResolution] = useState(item?.resolution ?? "");
  const [model, setModel] = useState(item?.model ?? "default");
  const [unitCost, setUnitCost] = useState(String(item?.unit_cost ?? 1));
  const [equivalentDivisor, setEquivalentDivisor] = useState(String(item?.equivalent_count_divisor ?? 1));
  const [displayText, setDisplayText] = useState(item?.display_text ?? "");
  const [busy, setBusy] = useState(false);

  const parsedUnitCost = Number(unitCost);
  const parsedDivisor = Number(equivalentDivisor);
  const parsedMin = durationMin.trim() === "" ? null : Number(durationMin);
  const parsedMax = durationMax.trim() === "" ? null : Number(durationMax);
  const durationValid =
    (parsedMin == null || (Number.isInteger(parsedMin) && parsedMin >= 0)) &&
    (parsedMax == null || (Number.isInteger(parsedMax) && parsedMax >= 0)) &&
    (parsedMin == null || parsedMax == null || parsedMin <= parsedMax);
  const canSave =
    Boolean(providerId.trim()) &&
    Boolean(mode.trim()) &&
    Number.isFinite(parsedUnitCost) &&
    parsedUnitCost >= 0 &&
    Number.isFinite(parsedDivisor) &&
    parsedDivisor > 0 &&
    durationValid;

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    try {
      await onSave({
        provider_id: providerId.trim(),
        mode: mode.trim(),
        duration_min: parseNullableNumber(durationMin),
        duration_max: parseNullableNumber(durationMax),
        resolution: resolution.trim() || null,
        model: model.trim() || null,
        unit_cost: parsedUnitCost,
        equivalent_count_divisor: parsedDivisor,
        display_text: displayText.trim() || null
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">{item ? "编辑扣减规则" : "新增扣减规则"}</div>
          <button className="modal-close" type="button" onClick={onClose} disabled={busy} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">厂商 <span className="required">*</span></label>
            {providerOptions.length > 0 ? (
              <select className="form-select form-input" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                <option value="">请选择厂商</option>
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}（{provider.id}）
                  </option>
                ))}
                {item && !providerOptions.some((provider) => provider.id === item.provider_id) ? (
                  <option value={item.provider_id}>{item.provider_id}</option>
                ) : null}
              </select>
            ) : (
              <input
                className="form-input"
                type="text"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                placeholder="输入厂商 ID，如 doubao"
              />
            )}
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">生成模式 <span className="required">*</span></label>
              <select className="form-select form-input" value={mode} onChange={(e) => setMode(e.target.value)}>
                {MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">分辨率</label>
              <input
                className="form-input"
                type="text"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                placeholder="如 480p / 720p / 1080p"
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">时长下限（秒）</label>
              <input
                className="form-input"
                type="number"
                min={0}
                value={durationMin}
                onChange={(e) => setDurationMin(e.target.value)}
                placeholder="可选"
              />
            </div>
            <div className="form-group">
              <label className="form-label">时长上限（秒）</label>
              <input
                className="form-input"
                type="number"
                min={0}
                value={durationMax}
                onChange={(e) => setDurationMax(e.target.value)}
                placeholder="可选"
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">单位成本 <span className="required">*</span></label>
              <input
                className="form-input"
                type="number"
                min={0}
                step="any"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">等效除数 <span className="required">*</span></label>
              <input
                className="form-input"
                type="number"
                min={0.01}
                step="any"
                value={equivalentDivisor}
                onChange={(e) => setEquivalentDivisor(e.target.value)}
              />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">模型</label>
            <input
              className="form-input"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="如 default / Seedance 2.0 Mini"
            />
          </div>
          <div className="form-group">
            <label className="form-label">显示文本</label>
            <input
              className="form-input"
              type="text"
              value={displayText}
              onChange={(e) => setDisplayText(e.target.value)}
              placeholder="如 豆包 5s 480p = 1次"
            />
          </div>
          {!durationValid ? (
            <div className="text-muted" style={{ fontSize: 12 }}>
              时长上限不能小于下限。
            </div>
          ) : null}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" type="button" onClick={() => void submit()} disabled={busy || !canSave}>
            {item ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteRuleModal({
  item,
  onCancel,
  onConfirm
}: {
  item: AdminCostRule;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">删除扣减规则</div>
          <button className="modal-close" type="button" onClick={onCancel} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>
            确认删除“{item.provider_id} / {modeLabel(item.mode)} / {formatDurationRange(item.duration_min, item.duration_max)}”这条规则吗？
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-danger" type="button" onClick={onConfirm}>
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}

function BatchDeleteModal({
  count,
  busy,
  onCancel,
  onConfirm
}: {
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">批量删除规则</div>
          <button className="modal-close" type="button" onClick={onCancel} disabled={busy} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>确认删除选中的 {count} 条扣减规则吗？删除后不可恢复。</p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="btn btn-danger" type="button" onClick={onConfirm} disabled={busy || count === 0}>
            {busy ? "删除中..." : `确认删除 ${count} 条`}
          </button>
        </div>
      </div>
    </div>
  );
}

function modeLabel(value: string): string {
  return MODE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function formatDurationRange(min: number | null, max: number | null): string {
  if (min != null && max != null) return `${min}-${max}s`;
  if (min != null) return `≥${min}s`;
  if (max != null) return `≤${max}s`;
  return "不限";
}

function parseNullableNumber(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toExportRule(item: AdminCostRule): Record<string, unknown> {
  return {
    provider_id: item.provider_id,
    mode: item.mode,
    duration_min: item.duration_min,
    duration_max: item.duration_max,
    resolution: item.resolution,
    model: item.model,
    unit_cost: item.unit_cost,
    equivalent_count_divisor: item.equivalent_count_divisor,
    display_text: item.display_text
  };
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function parseImportFile(text: string): CostRuleInput[] {
  const parsed = JSON.parse(text) as unknown;
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.rules)
      ? parsed.rules
      : [];

  if (rows.length > MAX_IMPORT_ROWS) {
    throw new Error(`单次最多导入 ${MAX_IMPORT_ROWS} 条规则`);
  }

  return rows.map((row, index) => {
    if (!isRecord(row)) {
      throw new Error(`第 ${index + 1} 行不是有效规则对象`);
    }

    const providerId = readString(row.provider_id, index, "provider_id");
    const mode = readString(row.mode, index, "mode");
    const unitCost = readNumber(row.unit_cost, index, "unit_cost");
    const divisor = readNumber(row.equivalent_count_divisor, index, "equivalent_count_divisor");
    if (unitCost < 0) throw new Error(`第 ${index + 1} 行 unit_cost 不能小于 0`);
    if (divisor <= 0) throw new Error(`第 ${index + 1} 行 equivalent_count_divisor 必须大于 0`);

    return {
      provider_id: providerId,
      mode,
      duration_min: readNullableInteger(row.duration_min, index, "duration_min"),
      duration_max: readNullableInteger(row.duration_max, index, "duration_max"),
      resolution: readNullableString(row.resolution),
      model: readNullableString(row.model),
      unit_cost: unitCost,
      equivalent_count_divisor: divisor,
      display_text: readNullableString(row.display_text)
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`第 ${index + 1} 行缺少字符串字段 ${field}`);
  }
  return value.trim();
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown, index: number, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`第 ${index + 1} 行字段 ${field} 不是有效数字`);
  }
  return number;
}

function readNullableNumber(value: unknown, index: number, field: string): number | null {
  if (value == null || value === "") return null;
  return readNumber(value, index, field);
}

function readNullableInteger(value: unknown, index: number, field: string): number | null {
  const number = readNullableNumber(value, index, field);
  if (number != null && (!Number.isInteger(number) || number < 0)) {
    throw new Error(`第 ${index + 1} 行字段 ${field} 必须是非负整数`);
  }
  return number;
}
