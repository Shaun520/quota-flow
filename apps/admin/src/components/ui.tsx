import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {actions ? <div className="toolbar">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  children,
  className = ""
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`.trim()}>
      {title ? <h2 className="card-title">{title}</h2> : null}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function KpiCard({
  label,
  value,
  delta,
  negative = false
}: {
  label: string;
  value: string;
  delta?: string;
  negative?: boolean;
}) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {delta ? <div className={`kpi-delta${negative ? " negative" : ""}`}>{delta}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "default"
}: {
  children: ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "info";
}) {
  return <span className={`badge ${tone === "default" ? "" : tone}`.trim()}>{children}</span>;
}

export interface TableColumn {
  key: string;
  label: string;
  render?: (row: Record<string, unknown>) => ReactNode;
}

export function DataTable({
  columns,
  rows,
  empty = "暂无数据"
}: {
  columns: TableColumn[];
  rows: Array<Record<string, unknown>>;
  empty?: string;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={String(row.key ?? index)}>
                {columns.map((column) => (
                  <td key={column.key}>{column.render ? column.render(row) : String(row[column.key] ?? "")}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
