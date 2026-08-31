"use client";

import { useCallback, useEffect, useState } from "react";
import {
  deleteGenerationJob,
  deleteGenerationJobs,
  formatCost,
  listGenerationJobs,
  modeLabel,
  statusBadge,
  type AdminGenerationJob,
  type GenerationJobStatusFilter,
  type GenerationJobTimeRange
} from "@/lib/api/generationJobs";
import { listProviderOptions, type ProviderOption } from "@/lib/api/cost-tables";
import { avatarColor, formatDateTime, initials } from "@/lib/utils/format";
import { Pagination } from "@/components/users/pagination";
import { isSupabaseConfigured } from "@/lib/supabase/env";

const PAGE_SIZE = 20;

export default function GenerationJobsPage() {
  const [items, setItems] = useState<AdminGenerationJob[]>([]);
  const [total, setTotal] = useState(0);
  const [providerId, setProviderId] = useState("");
  const [status, setStatus] = useState<GenerationJobStatusFilter>("");
  const [timeRange, setTimeRange] = useState<GenerationJobTimeRange>("7d");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [deleting, setDeleting] = useState<AdminGenerationJob | null>(null);
  const [detail, setDetail] = useState<AdminGenerationJob | null>(null);

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

  useEffect(() => {
    let mounted = true;
    listProviderOptions()
      .then((opts) => {
        if (mounted) setProviders(opts);
      })
      .catch(() => {
        /* 厂商下拉失败不阻塞页面 */
      });
    return () => {
      mounted = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listGenerationJobs({
        providerId,
        status,
        timeRange,
        search: debouncedSearch,
        page,
        pageSize: PAGE_SIZE
      });
      setItems(res.items);
      setTotal(res.total);
      setSelectedIds([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [providerId, status, timeRange, debouncedSearch, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.length === items.length ? [] : items.map((item) => item.id)));
  }

  async function handleDelete(item: AdminGenerationJob) {
    try {
      await deleteGenerationJob(item.id);
      setDeleting(null);
      setToast("记录已删除");
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
      setDeleting(null);
    }
  }

  async function handleBatchDelete() {
    if (selectedIds.length === 0 || batchDeleting) return;
    setBatchDeleting(true);
    try {
      await deleteGenerationJobs(selectedIds);
      setToast(`已删除 ${selectedIds.length} 条记录`);
      setBatchDeleting(false);
      setBatchModalOpen(false);
      setSelectedIds([]);
      void load();
    } catch (e) {
      setBatchDeleting(false);
      setToast(e instanceof Error ? e.message : "批量删除失败");
    }
  }

  if (!isSupabaseConfigured()) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">生成记录</h1>
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
          <h1 className="page-title">生成记录</h1>
          <p className="page-subtitle">查看用户调用 AI 生成视频的历史记录，可筛选、删除与批量删除。</p>
        </div>
        <div className="page-actions">
          {selectedIds.length > 0 ? (
            <button className="btn btn-danger btn-sm" onClick={() => setBatchModalOpen(true)}>
              批量删除（{selectedIds.length}）
            </button>
          ) : null}
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">搜索提示词/用户</span>
          <input
            className="form-input"
            type="search"
            placeholder="输入 Prompt、用户名或邮箱关键词"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <span className="filter-label">状态</span>
          <select
            className="form-select"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as GenerationJobStatusFilter);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            <option value="pending">排队中</option>
            <option value="running">生成中</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
            <option value="not_generated">无可用厂商</option>
          </select>
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
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <span className="filter-label">时间</span>
          <select
            className="form-select"
            value={timeRange}
            onChange={(e) => {
              setTimeRange(e.target.value as GenerationJobTimeRange);
              setPage(1);
            }}
          >
            <option value="24h">近 24 小时</option>
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
            <option value="all">全部时间</option>
          </select>
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ paddingTop: "var(--space-3)" }}>
          {loading ? (
            <GenerationJobsSkeleton />
          ) : error ? (
            <div className="empty-state">
              <h3>加载失败</h3>
              <p>{error}</p>
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <h3>暂无生成记录</h3>
              <p>当前筛选条件下没有匹配的生成记录。</p>
            </div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>
                      <input
                        type="checkbox"
                        checked={items.length > 0 && selectedIds.length === items.length}
                        onChange={toggleSelectAll}
                        aria-label="选择当前页全部"
                      />
                    </th>
                    <th>时间</th>
                    <th>用户</th>
                    <th>团队</th>
                    <th>厂商</th>
                    <th>模式</th>
                    <th>状态</th>
                    <th>费用</th>
                    <th>结果</th>
                    <th style={{ textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(item.id)}
                          onChange={() => toggleSelect(item.id)}
                          aria-label={`选择记录 ${userDisplay(item)}`}
                        />
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(item.created_at)}</td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 140 }}>
                          <div
                            className="admin-avatar"
                            style={{ width: 28, height: 28, fontSize: 11, background: avatarColor(item.user_id ?? item.id) }}
                          >
                            {initials(item.user_name, item.user_email)}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div className="cell-primary" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {item.user_name ?? "—"}
                            </div>
                            <div className="text-muted" style={{ fontSize: 12, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {item.user_email ?? "—"}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>{item.team_name ?? "—"}</td>
                      <td>{item.provider_name ?? item.provider_id ?? "—"}</td>
                      <td>{modeLabel(item.mode)}</td>
                      <td>
                        <span className={`badge ${statusBadgeClass(item.status)}`}>{statusBadge(item.status)}</span>
                      </td>
                      <td>{formatCost(item)}</td>
                      <td>
                        {item.result_url ? (
                          <a href={item.result_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary)" }}>
                            查看
                          </a>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td>
                        <div className="cell-actions" style={{ justifyContent: "flex-end" }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => setDetail(item)}>
                            详情
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
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </div>

      {deleting ? (
        <DeleteGenerationJobModal item={deleting} onCancel={() => setDeleting(null)} onConfirm={() => void handleDelete(deleting)} />
      ) : null}

      {batchModalOpen ? (
        <BatchDeleteGenerationJobsModal
          count={selectedIds.length}
          onCancel={() => setBatchModalOpen(false)}
          onConfirm={() => void handleBatchDelete()}
          busy={batchDeleting}
        />
      ) : null}

      {detail ? <GenerationJobDetailModal item={detail} onClose={() => setDetail(null)} /> : null}

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

function userDisplay(item: AdminGenerationJob): string {
  return item.user_name ?? item.user_email ?? item.user_id ?? item.id;
}

function statusBadgeClass(status: string): string {
  return (
    {
      pending: "badge-warning",
      running: "badge-info",
      success: "badge-success",
      failed: "badge-danger",
      not_generated: "badge-muted"
    }[status] ?? "badge-muted"
  );
}

function GenerationJobsSkeleton() {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} style={{ height: 60, borderRadius: 8, background: "var(--color-muted)", opacity: 0.5 }} />
      ))}
    </div>
  );
}

function DeleteGenerationJobModal({
  item,
  onCancel,
  onConfirm
}: {
  item: AdminGenerationJob;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">删除生成记录</div>
          <button className="modal-close" type="button" onClick={onCancel} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>
            确认删除 {userDisplay(item)} 的这条生成记录吗？
          </p>
          <p className="text-muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
            注意：删除将同时级联删除该记录关联的额度流水（quota_operations），此操作不可恢复。
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

function BatchDeleteGenerationJobsModal({
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
          <div className="modal-title">批量删除生成记录</div>
          <button className="modal-close" type="button" onClick={onCancel} disabled={busy} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>确认删除选中的 {count} 条生成记录吗？</p>
          <p className="text-muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
            注意：删除将同时级联删除这些记录关联的额度流水（quota_operations），此操作不可恢复。
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="btn btn-danger" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? "删除中..." : "确认删除"}
          </button>
        </div>
      </div>
    </div>
  );
}

function GenerationJobDetailModal({ item, onClose }: { item: AdminGenerationJob; onClose: () => void }) {
  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">生成记录详情</div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">用户</label>
              <div style={{ fontSize: 14 }}>{userDisplay(item)}</div>
            </div>
            <div className="form-group">
              <label className="form-label">团队</label>
              <div style={{ fontSize: 14 }}>{item.team_name ?? "—"}</div>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">厂商</label>
              <div style={{ fontSize: 14 }}>{item.provider_name ?? item.provider_id ?? "—"}</div>
            </div>
            <div className="form-group">
              <label className="form-label">模式</label>
              <div style={{ fontSize: 14 }}>{modeLabel(item.mode)}</div>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">状态</label>
              <div style={{ fontSize: 14 }}>
                <span className={`badge ${statusBadgeClass(item.status)}`}>{statusBadge(item.status)}</span>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">费用</label>
              <div className="cell-mono" style={{ fontSize: 14 }}>{formatCost(item)}</div>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">创建时间</label>
              <div style={{ fontSize: 14 }}>{formatDateTime(item.created_at)}</div>
            </div>
            <div className="form-group">
              <label className="form-label">完成时间</label>
              <div style={{ fontSize: 14 }}>{formatDateTime(item.completed_at)}</div>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Trace ID</label>
            <div style={{ fontSize: 14, wordBreak: "break-all" }}>{item.trace_id ?? "—"}</div>
          </div>
          <div className="form-group">
            <label className="form-label">结果链接</label>
            <div style={{ fontSize: 14, wordBreak: "break-all" }}>
              {item.result_url ? (
                <a href={item.result_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary)" }}>
                  {item.result_url}
                </a>
              ) : (
                "—"
              )}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">错误信息</label>
            <div style={{ fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{item.error ?? "—"}</div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Prompt</label>
            <div style={{ fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{item.prompt ?? "—"}</div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}