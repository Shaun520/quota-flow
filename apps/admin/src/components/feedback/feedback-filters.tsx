"use client";

import {
  FEEDBACK_TYPES,
  type FeedbackStatusFilter,
  type FeedbackTypeFilter
} from "@/lib/api/feedback";

export interface FeedbackFiltersValue {
  type: FeedbackTypeFilter;
  status: FeedbackStatusFilter;
  search: string;
}

export function FeedbackFilters({
  value,
  onChange
}: {
  value: FeedbackFiltersValue;
  onChange: (value: FeedbackFiltersValue) => void;
}) {
  return (
    <div className="filter-bar">
      <div className="filter-group">
        <span className="filter-label">问题类型</span>
        <select
          className="form-select"
          style={{ width: 130 }}
          value={value.type}
          onChange={(e) => onChange({ ...value, type: e.target.value as FeedbackTypeFilter })}
        >
          <option value="">全部</option>
          {FEEDBACK_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <span className="filter-label">处理状态</span>
        <select
          className="form-select"
          style={{ width: 120 }}
          value={value.status}
          onChange={(e) => onChange({ ...value, status: e.target.value as FeedbackStatusFilter })}
        >
          <option value="">全部</option>
          <option value="pending">待处理</option>
          <option value="resolved">已处理</option>
        </select>
      </div>

      <div className="filter-group" style={{ marginLeft: "auto" }}>
        <input
          type="text"
          placeholder="搜索标题 / 描述 / 联系方式..."
          style={{ width: 260 }}
          value={value.search}
          onChange={(e) => onChange({ ...value, search: e.target.value })}
        />
      </div>
    </div>
  );
}
