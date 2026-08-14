"use client";

import type { TeamStatusFilter } from "@/lib/api/teams";

export interface TeamFiltersValue {
  search: string;
  status: TeamStatusFilter;
}

export function TeamFilters({
  value,
  onChange
}: {
  value: TeamFiltersValue;
  onChange: (value: TeamFiltersValue) => void;
}) {
  return (
    <div className="filter-bar">
      <div className="filter-group">
        <span className="filter-label">状态</span>
        <select
          className="form-select"
          style={{ width: 120 }}
          value={value.status}
          onChange={(e) => onChange({ ...value, status: e.target.value as TeamStatusFilter })}
        >
          <option value="">全部</option>
          <option value="active">正常</option>
          <option value="banned">已封禁</option>
          <option value="exhausted">额度耗尽</option>
          <option value="expired">已过期</option>
        </select>
      </div>

      <div className="filter-group" style={{ marginLeft: "auto" }}>
        <input
          type="text"
          placeholder="搜索团队或负责人..."
          style={{ width: 240 }}
          value={value.search}
          onChange={(e) => onChange({ ...value, search: e.target.value })}
        />
      </div>
    </div>
  );
}
