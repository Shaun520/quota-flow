"use client";

function buildPages(current: number, total: number): Array<number | "..."> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages: Array<number | "..."> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  if (start > 2) pages.push("...");
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < total - 1) pages.push("...");
  pages.push(total);
  return pages;
}

export function Pagination({
  page,
  total,
  pageSize,
  onPageChange
}: {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const pages = buildPages(page, totalPages);

  return (
    <div className="pagination">
      <button
        className="page-btn"
        disabled={page <= 1}
        style={page <= 1 ? { opacity: 0.4, cursor: "default" } : undefined}
        onClick={() => onPageChange(page - 1)}
        aria-label="上一页"
      >
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>

      {pages.map((p, idx) =>
        p === "..." ? (
          <span key={`ellipsis-${idx}`} className="page-btn" style={{ border: "none", cursor: "default" }}>
            ...
          </span>
        ) : (
          <button
            key={p}
            className={`page-btn${p === page ? " active" : ""}`}
            onClick={() => onPageChange(p)}
          >
            {p}
          </button>
        )
      )}

      <button
        className="page-btn"
        disabled={page >= totalPages}
        style={page >= totalPages ? { opacity: 0.4, cursor: "default" } : undefined}
        onClick={() => onPageChange(page + 1)}
        aria-label="下一页"
      >
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    </div>
  );
}
