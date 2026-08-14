"use client";

import { useCallback, useEffect, useState } from "react";
import {
  downloadCsv,
  listAuditLogs,
  toCsv,
  type AuditLog,
  type AuditLogActionCategory,
  type AuditLogTimeRange
} from "@/lib/api/audit";
import { AuditFilters } from "@/components/audit/audit-filters";
import { AuditTable } from "@/components/audit/audit-table";
import { Pagination } from "@/components/users/pagination";

const PAGE_SIZE = 20;

export default function AuditPage() {
  const [action, setAction] = useState<AuditLogActionCategory>("");
  const [timeRange, setTimeRange] = useState<AuditLogTimeRange>("7d");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<{ total: number; items: AuditLog[] }>({ total: 0, items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [toast, setToast] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

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
      const res = await listAuditLogs({
        action,
        timeRange,
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
  }, [action, timeRange, debouncedSearch, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // 提示自动消失
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await listAuditLogs({
        action,
        timeRange,
        search: debouncedSearch,
        page: 1,
        pageSize: Math.min(result.total || 5000, 5000)
      });
      downloadCsv("audit-logs.csv", toCsv(res.items));
    } catch (e) {
      setToast(e instanceof Error ? e.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">审计日志</h1>
          <p className="page-subtitle">记录管理员关键操作，便于追溯与合规审计</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => void handleExport()} disabled={exporting}>
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {exporting ? "导出中..." : "导出 CSV"}
          </button>
        </div>
      </div>

      <AuditFilters
        value={{ action, timeRange, search }}
        onChange={(v) => {
          if (v.action !== action) {
            setAction(v.action);
            setPage(1);
          }
          if (v.timeRange !== timeRange) {
            setTimeRange(v.timeRange);
            setPage(1);
          }
          if (v.search !== search) setSearch(v.search);
        }}
      />

      <AuditTable logs={result.items} loading={loading} error={error} />

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
