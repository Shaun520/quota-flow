"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createCreationVideo,
  deleteCreationVideo,
  formatDuration,
  listCreationVideos,
  statusLabel,
  toggleCreationVideoEnabled,
  updateCreationVideo,
  type AdminCreationVideo,
  type CreationVideoInput,
  type CreationVideoStatusFilter
} from "@/lib/api/creationVideos";
import { Pagination } from "@/components/users/pagination";
import { isSupabaseConfigured } from "@/lib/supabase/env";

const PAGE_SIZE = 10;

const CATEGORY_OPTIONS = ["国漫3D风", "动作打斗", "赛博都市", "古风仙侠", "治愈系"];

export default function CreationVideosPage() {
  const [items, setItems] = useState<AdminCreationVideo[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<CreationVideoStatusFilter>("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; item: AdminCreationVideo } | null>(null);
  const [deleting, setDeleting] = useState<AdminCreationVideo | null>(null);

  const categoryOptions = useMemo(
    () => Array.from(new Set([...CATEGORY_OPTIONS, ...items.map((item) => item.category).filter(Boolean)])),
    [items]
  );

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
      const res = await listCreationVideos({
        search: debouncedSearch,
        category,
        status,
        page,
        pageSize: PAGE_SIZE
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, category, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function handleSave(input: CreationVideoInput) {
    try {
      if (editor?.mode === "edit") {
        await updateCreationVideo(editor.item.id, input);
        setToast("视频已更新");
      } else {
        await createCreationVideo(input);
        setToast("视频已创建");
      }
      setEditor(null);
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
    }
  }

  async function handleToggle(item: AdminCreationVideo) {
    try {
      await toggleCreationVideoEnabled(item.id, !item.enabled);
      setToast(item.enabled ? "视频已停用" : "视频已启用");
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
    }
  }

  async function handleDelete(item: AdminCreationVideo) {
    try {
      await deleteCreationVideo(item.id);
      setDeleting(null);
      setToast("视频已删除");
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
      setDeleting(null);
    }
  }

  if (!isSupabaseConfigured()) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">创作中心视频管理</h1>
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
          <h1 className="page-title">创作中心视频管理</h1>
          <p className="page-subtitle">管理桌面端创作中心“视频灵感库”展示的优秀视频、分类与参考 Prompt。</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setEditor({ mode: "create" })}>
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            新建视频
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">搜索标题/Prompt</span>
          <input
            className="form-input"
            type="search"
            placeholder="输入标题或 Prompt 关键词"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <span className="filter-label">分类</span>
          <select
            className="form-select"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部分类</option>
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <span className="filter-label">状态</span>
          <select
            className="form-select"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as CreationVideoStatusFilter);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            <option value="enabled">已启用</option>
            <option value="disabled">已停用</option>
          </select>
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ paddingTop: "var(--space-3)" }}>
          {loading ? (
            <CreationVideosSkeleton />
          ) : error ? (
            <div className="empty-state">
              <h3>加载失败</h3>
              <p>{error}</p>
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" />
              </svg>
              <h3>暂无视频作品</h3>
              <p>点击右上角“新建视频”创建第一条视频灵感。</p>
            </div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>封面/标题</th>
                    <th>分类</th>
                    <th>时长</th>
                    <th>标签</th>
                    <th>Prompt</th>
                    <th>状态</th>
                    <th>排序</th>
                    <th style={{ textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 220 }}>
                          <img
                            src={item.cover_url}
                            alt={item.title}
                            style={{ width: 64, height: 36, objectFit: "cover", borderRadius: 4, background: "var(--color-muted)" }}
                          />
                          <div style={{ maxWidth: 260, whiteSpace: "normal" }}>
                            <div className="cell-primary">{item.title}</div>
                            <div className="text-muted" style={{ fontSize: 12 }}>
                              {item.video_url ? "有视频链接" : "仅封面"}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>{item.category}</td>
                      <td>{formatDuration(item.duration_sec)}</td>
                      <td>
                        <div style={{ maxWidth: 240, whiteSpace: "normal" }}>
                          {item.tags.length > 0 ? item.tags.join("、") : "—"}
                        </div>
                      </td>
                      <td>
                        <div style={{ maxWidth: 360, whiteSpace: "normal", fontSize: 12, color: "#475569" }}>
                          {item.prompt.length > 90 ? `${item.prompt.slice(0, 90)}...` : item.prompt}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${item.enabled ? "badge-success" : "badge-warning"}`}>{statusLabel(item.enabled)}</span>
                      </td>
                      <td>{item.sort_order}</td>
                      <td>
                        <div className="cell-actions" style={{ justifyContent: "flex-end" }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditor({ mode: "edit", item })}>
                            编辑
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => void handleToggle(item)}>
                            {item.enabled ? "停用" : "启用"}
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

      {editor ? (
        <CreationVideoEditorModal
          item={editor.mode === "edit" ? editor.item : null}
          onClose={() => setEditor(null)}
          onSave={(input) => void handleSave(input)}
        />
      ) : null}

      {deleting ? (
        <DeleteCreationVideoModal item={deleting} onCancel={() => setDeleting(null)} onConfirm={() => void handleDelete(deleting)} />
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

function CreationVideosSkeleton() {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} style={{ height: 72, borderRadius: 8, background: "var(--color-muted)", opacity: 0.5 }} />
      ))}
    </div>
  );
}

function CreationVideoEditorModal({
  item,
  onClose,
  onSave
}: {
  item: AdminCreationVideo | null;
  onClose: () => void;
  onSave: (input: CreationVideoInput) => void;
}) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [coverUrl, setCoverUrl] = useState(item?.cover_url ?? "");
  const [videoUrl, setVideoUrl] = useState(item?.video_url ?? "");
  const [durationSec, setDurationSec] = useState(String(item?.duration_sec ?? 5));
  const [category, setCategory] = useState(item?.category ?? "");
  const [tags, setTags] = useState(item?.tags.join(", ") ?? "");
  const [prompt, setPrompt] = useState(item?.prompt ?? "");
  const [providerHint, setProviderHint] = useState(item?.provider_hint ?? "");
  const [sortOrder, setSortOrder] = useState(String(item?.sort_order ?? 0));
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!title.trim() || !coverUrl.trim() || !prompt.trim()) return;
    setBusy(true);
    onSave({
      title,
      cover_url: coverUrl,
      video_url: videoUrl || null,
      duration_sec: Number(durationSec) || 5,
      category: category || "未分类",
      tags: tags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      prompt,
      provider_hint: providerHint || null,
      enabled,
      sort_order: Number(sortOrder) || 0
    });
    setBusy(false);
  }

  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">{item ? "编辑视频作品" : "新建视频作品"}</div>
          <button className="modal-close" type="button" onClick={onClose} disabled={busy} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">标题 <span className="required">*</span></label>
            <input className="form-input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="输入视频标题" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">封面 URL <span className="required">*</span></label>
              <input className="form-input" type="url" value={coverUrl} onChange={(e) => setCoverUrl(e.target.value)} placeholder="https://..." />
            </div>
            <div className="form-group">
              <label className="form-label">视频 URL</label>
              <input className="form-input" type="url" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://...，可留空" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">时长（秒）</label>
              <input className="form-input" type="number" min={1} value={durationSec} onChange={(e) => setDurationSec(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">排序</label>
              <input className="form-input" type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">分类</label>
              <input className="form-input" type="text" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="国漫3D风、动作打斗等" />
            </div>
            <div className="form-group">
              <label className="form-label">标签</label>
              <input className="form-input" type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="用逗号分隔，如：国漫3D, 雪山" />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Prompt <span className="required">*</span></label>
            <textarea className="form-input" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="输入完整参考 Prompt..." />
          </div>
          <div className="form-group">
            <label className="form-label">厂商提示</label>
            <input className="form-input" type="text" value={providerHint} onChange={(e) => setProviderHint(e.target.value)} placeholder="如：豆包 · Seedance 2.0 Mini" />
          </div>
          <label className="form-check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            启用展示
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void submit()}
            disabled={busy || !title.trim() || !coverUrl.trim() || !prompt.trim()}
          >
            {item ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteCreationVideoModal({
  item,
  onCancel,
  onConfirm
}: {
  item: AdminCreationVideo;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">删除视频作品</div>
          <button className="modal-close" type="button" onClick={onCancel} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>确认删除“{item.title}”吗？删除后桌面端将不再展示该视频灵感。</p>
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
