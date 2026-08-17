"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listFeedback,
  setFeedbackStatus,
  type FeedbackItem,
  type FeedbackStatusFilter,
  type FeedbackTypeFilter
} from "@/lib/api/feedback";
import { FeedbackFilters } from "@/components/feedback/feedback-filters";
import { FeedbackTable } from "@/components/feedback/feedback-table";
import { Pagination } from "@/components/users/pagination";

const PAGE_SIZE = 20;

export default function FeedbackPage() {
  const [type, setType] = useState<FeedbackTypeFilter>("");
  const [status, setStatus] = useState<FeedbackStatusFilter>("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<{ total: number; items: FeedbackItem[] }>({
    total: 0,
    items: []
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [toast, setToast] = useState<string | null>(null);

  // 搜索输入 300ms 防抖后提交
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
      const res = await listFeedback({
        type,
        status,
        search: debouncedSearch,
        page,
        pageSize: PAGE_SIZE
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [type, status, debouncedSearch, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // 提示自动消失
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function handleToggleStatus(item: FeedbackItem) {
    const next: FeedbackItem["status"] = item.status === "resolved" ? "pending" : "resolved";
    try {
      await setFeedbackStatus(item.id, next, {
        userId: item.user_id,
        previousStatus: item.status
      });
      setToast(next === "resolved" ? "已标记为已处理" : "已标记为待处理");
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">反馈管理</h1>
          <p className="page-subtitle">汇总桌面端用户问题反馈，及时跟进处理</p>
        </div>
      </div>

      <FeedbackFilters
        value={{ type, status, search }}
        onChange={(v) => {
          if (v.type !== type) {
            setType(v.type);
            setPage(1);
          }
          if (v.status !== status) {
            setStatus(v.status);
            setPage(1);
          }
          if (v.search !== search) setSearch(v.search);
        }}
      />

      <FeedbackTable items={result.items} loading={loading} error={error} onToggleStatus={handleToggleStatus} />

      <div className="card" style={{ marginTop: 12 }}>
        <Pagination page={page} total={result.total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </div>

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
