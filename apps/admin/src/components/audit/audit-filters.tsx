"use client";

import {
  AUDIT_ACTION_GROUPS,
  type AuditLogActionCategory,
  type AuditLogTimeRange
} from "@/lib/api/audit";

export interface AuditFiltersValue {
  action: AuditLogActionCategory;
  timeRange: AuditLogTimeRange;
  search: string;
}

export function AuditFilters({
  value,
  onChange
}: {
  value: AuditFiltersValue;
  onChange: (value: AuditFiltersValue) => void;
}) {
  return (
    <div className="filter-bar">
      <div className="filter-group">
        <span className="filter-label">操作类型</span>
        <select
          className="form-select"
          style={{ width: 140 }}
          value={value.action}
          onChange={(e) => onChange({ ...value, action: e.target.value as AuditLogActionCategory })}
        >
          <option value="">全部</option>
          {AUDIT_ACTION_GROUPS.map((group) => (
            <optgroup key={group.value} label={group.label}>
              <option value={group.value}>{group.label}（全部）</option>
              {group.actions.map((action) => (
                <option key={action.value} value={action.value}>
                  {action.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <span className="filter-label">时间范围</span>
        <select
          className="form-select"
          style={{ width: 120 }}
          value={value.timeRange}
          onChange={(e) => onChange({ ...value, timeRange: e.target.value as AuditLogTimeRange })}
        >
          <option value="24h">近 24 小时</option>
          <option value="7d">近 7 天</option>
          <option value="30d">近 30 天</option>
          <option value="all">全部</option>
        </select>
      </div>

      <div className="filter-group" style={{ marginLeft: "auto" }}>
        <input
          type="text"
          placeholder="搜索对象 ID 或详情..."
          style={{ width: 240 }}
          value={value.search}
          onChange={(e) => onChange({ ...value, search: e.target.value })}
        />
      </div>
    </div>
  );
}
