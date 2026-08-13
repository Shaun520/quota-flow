"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createAnnouncement,
  deleteAnnouncement,
  kindLabel,
  listAnnouncements,
  publishedLabel,
  toggleAnnouncementPublished,
  updateAnnouncement,
  type AdminAnnouncement,
  type AnnouncementInput,
  type AnnouncementKind,
  type AnnouncementKindFilter
} from "@/lib/api/announcements";

export default function AnnouncementsPage() {
  const [items, setItems] = useState<AdminAnnouncement[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [kind, setKind] = useState<AnnouncementKindFilter>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; item: AdminAnnouncement } | null>(null);
  const [deleting, setDeleting] = useState<AdminAnnouncement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch((prev) => {
        if (prev === search) return prev;
        return search;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listAnnouncements({ search: debouncedSearch, kind }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function handleSave(input: AnnouncementInput) {
    try {
      if (editor?.mode === "edit") {
        await updateAnnouncement(editor.item.id, input);
        setToast("公告已更新");
      } else {
        await createAnnouncement(input);
        setToast("公告已发布");
      }
      setEditor(null);
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
    }
  }

  async function handleToggle(item: AdminAnnouncement) {
    try {
      await toggleAnnouncementPublished(item.id, !item.published, item.title);
      setToast(item.published ? "公告已下架" : "公告已发布");
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
    }
  }

  async function handleDelete(item: AdminAnnouncement) {
    try {
      await deleteAnnouncement(item.id, item.title);
      setDeleting(null);
      setToast("公告已删除");
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
      setDeleting(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">公告通知</h1>
          <p className="page-subtitle">向所有用户发布系统公告或版本更新说明</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setEditor({ mode: "create" })}>
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            发布公告
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">搜索标题</span>
          <input
            className="form-input"
            type="search"
            placeholder="输入公告标题"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <span className="filter-label">类型</span>
          <select className="form-select" value={kind} onChange={(e) => setKind(e.target.value as AnnouncementKindFilter)}>
            <option value="">全部</option>
            <option value="notice">公告</option>
            <option value="update">版本更新</option>
          </select>
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ paddingTop: "var(--space-3)" }}>
          {loading ? (
            <AnnouncementSkeleton />
          ) : error ? (
            <div className="empty-state">
              <h3>加载失败</h3>
              <p>{error}</p>
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <h3>暂无公告</h3>
              <p>点击右上角“发布公告”创建第一条通知。</p>
            </div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>标题</th>
                    <th>状态</th>
                    <th>发布时间</th>
                    <th style={{ textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <span className={`badge ${item.kind === "update" ? "badge-info" : "badge-success"}`}>
                          {kindLabel(item.kind)}
                        </span>
                      </td>
                      <td>
                        <strong>{item.title}</strong>
                        <div className="text-muted" style={{ fontSize: 12, marginTop: 2, maxWidth: 560 }}>
                          {item.content.length > 120 ? `${item.content.slice(0, 120)}...` : item.content}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${item.published ? "badge-success" : "badge-warning"}`}>
                          {publishedLabel(item.published)}
                        </span>
                      </td>
                      <td>{formatDate(item.created_at)}</td>
                      <td>
                        <div className="cell-actions" style={{ justifyContent: "flex-end" }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditor({ mode: "edit", item })}>
                            编辑
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => void handleToggle(item)}>
                            {item.published ? "下架" : "发布"}
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

      {editor ? (
        <AnnouncementEditorModal
          item={editor.mode === "edit" ? editor.item : null}
          onClose={() => setEditor(null)}
          onSave={(input) => void handleSave(input)}
        />
      ) : null}

      {deleting ? (
        <DeleteAnnouncementModal
          item={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void handleDelete(deleting)}
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

function AnnouncementSkeleton() {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} style={{ height: 64, borderRadius: 8, background: "var(--color-muted)", opacity: 0.5 }} />
      ))}
    </div>
  );
}

function AnnouncementEditorModal({
  item,
  onClose,
  onSave
}: {
  item: AdminAnnouncement | null;
  onClose: () => void;
  onSave: (input: AnnouncementInput) => void;
}) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [content, setContent] = useState(item?.content ?? "");
  const [kind, setKind] = useState<AnnouncementKind>(item?.kind ?? "notice");
  const [published, setPublished] = useState(item?.published ?? true);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    onSave({ title, content, kind, published });
    setBusy(false);
  }

  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">{item ? "编辑公告" : "发布公告"}</div>
          <button className="modal-close" type="button" onClick={onClose} disabled={busy} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">类型</label>
            <select className="form-select form-input" value={kind} onChange={(e) => setKind(e.target.value as AnnouncementKind)}>
              <option value="notice">公告</option>
              <option value="update">版本更新</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">标题 <span className="required">*</span></label>
            <input className="form-input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="输入公告标题" />
          </div>
          <div className="form-group">
            <label className="form-label">内容 <span className="required">*</span></label>
            <textarea className="form-input" rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="输入公告内容..." />
          </div>
          <label className="form-check">
            <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} />
            立即发布
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn btn-primary" type="button" onClick={() => void submit()} disabled={busy || !title.trim() || !content.trim()}>
            {item ? "保存" : "发布"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteAnnouncementModal({
  item,
  onCancel,
  onConfirm
}: {
  item: AdminAnnouncement;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">删除公告</div>
          <button className="modal-close" type="button" onClick={onCancel} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>确认删除“{item.title}”吗？删除后桌面端将不再显示。</p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" type="button" onClick={onCancel}>取消</button>
          <button className="btn btn-danger" type="button" onClick={onConfirm}>确认删除</button>
        </div>
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}
