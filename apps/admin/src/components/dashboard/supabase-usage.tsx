"use client";

import type { SupabaseUsage } from "@/lib/api/dashboard";

function formatMb(bytes: number | null): string {
  if (bytes == null) return "未知";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatGb(bytes: number | null): string {
  if (bytes == null) return "未知";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function SupabaseUsageCard({ usage, loading }: { usage: SupabaseUsage | null; loading: boolean }) {
  const rows = [
    { label: "数据库占用", value: loading || !usage ? "—" : formatMb(usage.db_size_bytes) },
    { label: "MAU（近30天）", value: loading || !usage ? "—" : `${usage.mau.toLocaleString("zh-CN")} 人` },
    { label: "Edge 函数", value: "不适用" },
    { label: "存储", value: loading || !usage ? "—" : formatGb(usage.storage_bytes) }
  ];

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Supabase 用量</div>
          <div className="card-subtitle">免费层当前用量（真实测量）</div>
        </div>
      </div>
      <div className="card-body">
        {rows.map((row) => (
          <div className="usage-meter" key={row.label}>
            <span className="usage-meter-label">{row.label}</span>
            <div className="usage-meter-bar" />
            <span className="usage-meter-value">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}