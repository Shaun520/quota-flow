"use client";

import { useCallback, useEffect, useState } from "react";
import {
  downloadCsv,
  listUsers,
  setUserStatus,
  toCsv,
  type AdminUser,
  type RoleFilter,
  type StatusFilter
} from "@/lib/api/users";
import { UserFilters } from "@/components/users/user-filters";
import { UserTable } from "@/components/users/user-table";
import { UserDetailModal } from "@/components/users/user-detail-modal";
import { Pagination } from "@/components/users/pagination";

const PAGE_SIZE = 20;

export default function UsersPage() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [role, setRole] = useState<RoleFilter>("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<{ total: number; items: AdminUser[] }>({ total: 0, items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detailUser, setDetailUser] = useState<AdminUser | null>(null);
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
      const res = await listUsers({
        search: debouncedSearch,
        role,
        status,
        page,
        pageSize: PAGE_SIZE
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, role, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // 提示自动消失
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function handleToggleBan(user: AdminUser) {
    const next = user.status === "banned" ? "active" : "banned";
    try {
      await setUserStatus(user.id, next);
      setToast(next === "banned" ? `已封禁 ${user.display_name ?? user.email ?? "该用户"}` : `已解封 ${user.display_name ?? user.email ?? "该用户"}`);
      void load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const res = await listUsers({
        search: debouncedSearch,
        role,
        status,
        page: 1,
        pageSize: Math.min(result.total || 5000, 5000)
      });
      downloadCsv("users.csv", toCsv(res.items));
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
          <h1 className="page-title">用户管理</h1>
          <p className="page-subtitle">查看所有注册用户与消费统计</p>
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

      <UserFilters
        value={{ search, role, status }}
        onChange={(v) => {
          if (v.search !== search) setSearch(v.search);
          if (v.role !== role) {
            setRole(v.role);
            setPage(1);
          }
          if (v.status !== status) {
            setStatus(v.status);
            setPage(1);
          }
        }}
      />

      <UserTable
        users={result.items}
        loading={loading}
        error={error}
        onDetail={setDetailUser}
        onToggleBan={(user) => void handleToggleBan(user)}
      />

      <div className="card" style={{ marginTop: 12 }}>
        <Pagination
          page={page}
          total={result.total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </div>

      <UserDetailModal user={detailUser} onClose={() => setDetailUser(null)} />

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
