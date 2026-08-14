"use client";

import { useCallback, useEffect, useState } from "react";
import { listTeams, type AdminTeam, type TeamStatusFilter } from "@/lib/api/teams";
import { TeamFilters } from "@/components/teams/team-filters";
import { TeamTable } from "@/components/teams/team-table";
import { TeamDetailModal } from "@/components/teams/team-detail-modal";
import { Pagination } from "@/components/users/pagination";

const PAGE_SIZE = 20;

export default function TeamsPage() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<TeamStatusFilter>("");
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<{ total: number; items: AdminTeam[] }>({
    total: 0,
    items: []
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detailTeam, setDetailTeam] = useState<AdminTeam | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
      const res = await listTeams({
        search: debouncedSearch,
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
  }, [debouncedSearch, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  function handleSaved(team: AdminTeam) {
    setResult((prev) => ({
      total: prev.total,
      items: prev.items.map((it) => (it.id === team.id ? team : it))
    }));
    setDetailTeam(team);
    setToast(`已更新 ${team.name}`);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">团队管理</h1>
          <p className="page-subtitle">查看团队、成员、订阅与用量，维护团队状态</p>
        </div>
      </div>

      <TeamFilters
        value={{ search, status }}
        onChange={(v) => {
          if (v.search !== search) setSearch(v.search);
          if (v.status !== status) {
            setStatus(v.status);
            setPage(1);
          }
        }}
      />

      <TeamTable
        teams={result.items}
        loading={loading}
        error={error}
        onDetail={setDetailTeam}
      />

      <div className="card" style={{ marginTop: 12 }}>
        <Pagination
          page={page}
          total={result.total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </div>

      <TeamDetailModal
        team={detailTeam}
        onClose={() => setDetailTeam(null)}
        onSaved={handleSaved}
      />

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
