"use client";

import type { RoleFilter, StatusFilter } from "@/lib/api/users";

export interface UserFiltersValue {
  search: string;
  role: RoleFilter;
  status: StatusFilter;
}

export function UserFilters({
  value,
  onChange
}: {
  value: UserFiltersValue;
  onChange: (value: UserFiltersValue) => void;
}) {
  return (
    <div className="filter-bar">
      <div className="filter-group">
        <span className="filter-label">角色</span>
        <select
          className="form-select"
          style={{ width: 120 }}
          value={value.role}
          onChange={(e) => onChange({ ...value, role: e.target.value as RoleFilter })}
        >
          <option value="">全部</option>
          <option value="admin">Admin</option>
          <option value="member">Member</option>
          <option value="none">个人</option>
        </select>
      </div>

      <div className="filter-group">
        <span className="filter-label">状态</span>
        <select
          className="form-select"
          style={{ width: 120 }}
          value={value.status}
          onChange={(e) => onChange({ ...value, status: e.target.value as StatusFilter })}
        >
          <option value="">全部</option>
          <option value="active">正常</option>
          <option value="banned">已封禁</option>
          <option value="exhausted">额度耗尽</option>
        </select>
      </div>

      <div className="filter-group" style={{ marginLeft: "auto" }}>
        <input
          type="text"
          placeholder="搜索邮箱或用户名..."
          style={{ width: 220 }}
          value={value.search}
          onChange={(e) => onChange({ ...value, search: e.target.value })}
        />
      </div>
    </div>
  );
}
