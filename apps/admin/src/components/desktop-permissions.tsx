"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createAdminBrowserClient } from "@/lib/supabase/client";
import { listTeamOptions, type TeamOption } from "@/lib/api/teams";

export const PERMISSION_FEATURE_KEYS = [
  "tab.dispatch",
  "tab.providers",
  "tab.history",
  "tab.team",
  "tab.creation",
  "dispatch.text2video",
  "dispatch.img2video",
  "dispatch.multi_ref",
  "dispatch.first_last",
  "dispatch.first_frame",
  "providers.bind",
  "history.detail",
  "history.regenerate",
  "history.copy_prompt",
  "history.watermark_removal",
  "creation.ai_toolbox",
  "creation.watermark",
  "creation.prompt_expander",
  "creation.storyboard",
  "creation.video_library",
  "creation.community"
] as const;

type FeatureKey = (typeof PERMISSION_FEATURE_KEYS)[number];

interface FeatureItem {
  key: FeatureKey;
  label: string;
  description: string;
}

const FEATURES: FeatureItem[] = [
  { key: "tab.dispatch", label: "调度台", description: "桌面端主 Tab：调度台" },
  { key: "tab.providers", label: "厂商", description: "桌面端主 Tab：厂商管理" },
  { key: "tab.history", label: "历史", description: "桌面端主 Tab：历史记录" },
  { key: "tab.team", label: "团队", description: "桌面端主 Tab：团队" },
  { key: "tab.creation", label: "创作中心", description: "桌面端主 Tab：创作中心" },
  { key: "dispatch.text2video", label: "文生视频", description: "调度台生成模式：文生视频" },
  { key: "dispatch.img2video", label: "图生视频", description: "调度台生成模式：图生视频" },
  { key: "dispatch.multi_ref", label: "多参考生成", description: "调度台生成模式：多参考生成" },
  { key: "dispatch.first_last", label: "首尾帧生成", description: "调度台生成模式：首尾帧生成" },
  { key: "dispatch.first_frame", label: "首帧生成", description: "调度台生成模式：首帧生成" },
  { key: "providers.bind", label: "绑定账号", description: "厂商页新增/绑定账号入口" },
  { key: "history.detail", label: "历史详情", description: "历史记录查看详情入口" },
  { key: "history.regenerate", label: "重新生成", description: "历史详情重新生成入口" },
  { key: "history.copy_prompt", label: "复制提示词", description: "历史详情复制提示词入口" },
  { key: "history.watermark_removal", label: "去水印", description: "历史记录去水印/框选/重试入口" },
  { key: "creation.watermark", label: "去水印", description: "创作中心 AI 工具箱：去水印入口" },
  { key: "creation.prompt_expander", label: "提示词扩展", description: "创作中心 AI 工具箱：提示词扩展（待接入）" },
  { key: "creation.storyboard", label: "分镜生成", description: "创作中心 AI 工具箱：分镜生成（待接入）" },
  { key: "creation.community", label: "视频灵感库", description: "创作中心视频灵感库：优秀视频与参考提示词" }
];

const MAIN_TAB_FEATURES = FEATURES.filter((feature) => feature.key.startsWith("tab."));

interface FeatureGroup {
  groupKey: FeatureKey;
  tabKey: FeatureKey;
  tabLabel: string;
  title: string;
  sectionTitle: string;
  features: FeatureItem[];
}

const CREATION_AI_TOOLBOX_KEYS = new Set<string>([
  "creation.watermark",
  "creation.prompt_expander",
  "creation.storyboard"
]);

function buildFeatureGroups(): FeatureGroup[] {
  const groups: FeatureGroup[] = [];
  const tabs: Array<{ tabKey: FeatureKey; tabLabel: string; match: (key: string) => boolean }> = [
    {
      tabKey: "tab.dispatch",
      tabLabel: "调度台",
      match: (key) => key.startsWith("dispatch.")
    },
    {
      tabKey: "tab.providers",
      tabLabel: "厂商",
      match: (key) => key.startsWith("providers.")
    },
    {
      tabKey: "tab.history",
      tabLabel: "历史",
      match: (key) => key.startsWith("history.")
    },
    {
      tabKey: "tab.creation",
      tabLabel: "创作中心",
      match: (key) => key.startsWith("creation.")
    }
  ];

  for (const tab of tabs) {
    const features = FEATURES.filter((feature) => tab.match(feature.key));
    if (tab.tabKey !== "tab.creation") {
      groups.push({
        groupKey: tab.tabKey,
        tabKey: tab.tabKey,
        tabLabel: tab.tabLabel,
        title: `${tab.tabLabel}功能`,
        sectionTitle: `${tab.tabLabel}功能`,
        features
      });
      continue;
    }

    groups.push({
      groupKey: "creation.ai_toolbox",
      tabKey: "tab.creation",
      tabLabel: "创作中心",
      title: "AI 工具箱",
      sectionTitle: "创作中心 · AI 工具箱",
      features: features.filter((feature) => CREATION_AI_TOOLBOX_KEYS.has(feature.key))
    });
    groups.push({
      groupKey: "creation.video_library",
      tabKey: "tab.creation",
      tabLabel: "创作中心",
      title: "视频灵感库",
      sectionTitle: "创作中心 · 视频灵感库",
      features: features.filter((feature) => feature.key === "creation.community")
    });
  }

  return groups;
}

const FEATURE_GROUPS = buildFeatureGroups();

type Scope = { kind: "global"; id: null; label: string } | { kind: "team"; id: string; label: string };

const DEFAULT_VALUES: Record<FeatureKey, boolean> = Object.fromEntries(
  PERMISSION_FEATURE_KEYS.map((key) => [key, true])
) as Record<FeatureKey, boolean>;

interface PermissionRow {
  feature_key: string;
  enabled: boolean;
}

async function fetchPermissionRows(scope: Scope): Promise<PermissionRow[]> {
  const supabase = createAdminBrowserClient();
  const { data: globalRows, error: globalError } = await supabase
    .from("desktop_permissions")
    .select("feature_key, enabled")
    .eq("target_type", "global")
    .is("target_id", null);
  if (globalError) throw globalError;
  const rows = [...((globalRows ?? []) as PermissionRow[])];
  if (scope.kind === "team") {
    const { data: teamRows, error: teamError } = await supabase
      .from("desktop_permissions")
      .select("feature_key, enabled")
      .eq("target_type", "team")
      .eq("target_id", scope.id);
    if (teamError) throw teamError;
    rows.push(...((teamRows ?? []) as PermissionRow[]));
  }
  return rows;
}

function applyRows(values: Record<FeatureKey, boolean>, rows: PermissionRow[]): Record<FeatureKey, boolean> {
  const next = { ...values };
  for (const row of rows) {
    if (PERMISSION_FEATURE_KEYS.includes(row.feature_key as FeatureKey)) {
      next[row.feature_key as FeatureKey] = !!row.enabled;
    }
  }
  return next;
}

export function DesktopPermissionsPage() {
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [scopeKey, setScopeKey] = useState("global");
  const [values, setValues] = useState<Record<FeatureKey, boolean>>(() => ({ ...DEFAULT_VALUES }));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);

  const scope = useMemo<Scope>(() => {
    if (scopeKey.startsWith("team:")) {
      const id = scopeKey.slice("team:".length);
      const team = teams.find((t) => t.id === id);
      return { kind: "team", id, label: team ? team.name : "团队" };
    }
    return { kind: "global", id: null, label: "全局默认" };
  }, [scopeKey, teams]);

  const loadTeams = useCallback(async () => {
    try {
      const options = await listTeamOptions();
      setTeams(options);
    } catch (e) {
      setError(e instanceof Error ? e.message : "团队列表加载失败");
    }
  }, []);

  const loadPermissions = useCallback(async (nextScope: Scope) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchPermissionRows(nextScope);
      setValues(applyRows({ ...DEFAULT_VALUES }, rows));
    } catch (e) {
      setError(e instanceof Error ? e.message : "权限配置加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleGroupToggle = useCallback((group: FeatureGroup, checked: boolean) => {
    setValues((prev) => {
      const next = { ...prev, [group.groupKey]: checked };
      for (const feature of group.features) {
        next[feature.key] = checked;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    void loadPermissions(scope);
  }, [scope, loadPermissions]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const save = async () => {
    if (!scope.id && scope.kind === "team") return;
    const mainTabKeys: FeatureKey[] = ["tab.dispatch", "tab.providers", "tab.history", "tab.team", "tab.creation"];
    if (!mainTabKeys.some((key) => values[key])) {
      setError("至少需要保留一个主 Tab，避免桌面端没有可用模块");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const supabase = createAdminBrowserClient();
      const {
        data: { user }
      } = await supabase.auth.getUser();
      const adminId = user?.id ?? null;

      if (scope.kind === "global") {
        const { error: deleteError } = await supabase
          .from("desktop_permissions")
          .delete()
          .eq("target_type", "global")
          .is("target_id", null);
        if (deleteError) throw deleteError;
      } else {
        const { error: deleteError } = await supabase
          .from("desktop_permissions")
          .delete()
          .eq("target_type", "team")
          .eq("target_id", scope.id);
        if (deleteError) throw deleteError;
      }

      const rows = PERMISSION_FEATURE_KEYS.map((featureKey) => ({
        target_type: scope.kind,
        target_id: scope.kind === "team" ? scope.id : null,
        feature_key: featureKey,
        enabled: values[featureKey],
        updated_by: adminId,
        updated_at: new Date().toISOString()
      }));
      const { error: insertError } = await supabase.from("desktop_permissions").insert(rows);
      if (insertError) throw insertError;

      setNotice(`已保存：${scope.label}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "权限配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">权限控制</h1>
          <p className="page-subtitle">控制桌面端主 Tab 与主 Tab 下的功能显示开关</p>
        </div>
        <div className="page-actions">
          <select
            value={scopeKey}
            onChange={(e) => setScopeKey(e.target.value)}
            aria-label="权限作用范围"
            style={{ minWidth: 220 }}
          >
            <option value="global">全局默认</option>
            {teams.map((team) => (
              <option key={team.id} value={`team:${team.id}`}>
                团队：{team.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={saving || loading} onClick={() => void save()}>
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger">
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{error}</span>
        </div>
      ) : null}

      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">{scope.label}</div>
            <div className="card-subtitle">未配置的开关默认开启；保存时会把当前作用域下所有开关写为明确值。</div>
          </div>
          {loading ? <span className="badge badge-muted">加载中</span> : <span className="badge badge-success">已加载</span>}
        </div>
        <div className="card-body">
          {loading ? (
            <div className="empty-state">正在加载权限配置...</div>
          ) : (
            <div className="permission-layout">
              <section className="permission-section permission-tab-section">
                <div className="permission-section-title">主 Tab 栏</div>
                <div className="permission-check-grid permission-tab-grid">
                  {MAIN_TAB_FEATURES.map((feature) => (
                    <div className="permission-check-item permission-tab-check" key={feature.key}>
                      <label className="permission-tab-check-label">
                        <input
                          type="checkbox"
                          checked={values[feature.key]}
                          onChange={(e) =>
                            setValues((prev) => ({ ...prev, [feature.key]: e.target.checked }))
                          }
                        />
                        <span>
                          <span className="permission-check-label">{feature.label}</span>
                          <span className="permission-check-hint">
                            {values[feature.key] ? "显示该主 Tab" : "隐藏该主 Tab"}
                          </span>
                        </span>
                      </label>
                      <div className="permission-tab-actions">
                        {FEATURE_GROUPS.filter((group) => group.tabKey === feature.key).map((group) => {
                          const expanded = expandedGroups.includes(group.groupKey);
                          const label =
                            group.tabKey === "tab.creation"
                              ? `${expanded ? "收起 " : "展开 "}${group.title}`
                              : expanded
                                ? "收起功能"
                                : "展开功能";
                          if (group.tabKey === "tab.creation") {
                            const groupEnabled = values[group.groupKey];
                            return (
                              <div
                                className={"permission-tab-subgroup" + (groupEnabled ? "" : " muted")}
                                key={group.groupKey}
                              >
                                <label className="permission-tab-subgroup-label">
                                  <input
                                    type="checkbox"
                                    checked={groupEnabled}
                                    onChange={(e) => handleGroupToggle(group, e.target.checked)}
                                  />
                                  <span>{group.title}</span>
                                </label>
                                <button
                                  className="btn-sm"
                                  type="button"
                                  disabled={!values[feature.key]}
                                  onClick={() =>
                                    setExpandedGroups((prev) =>
                                      prev.includes(group.groupKey)
                                        ? prev.filter((key) => key !== group.groupKey)
                                        : [...prev, group.groupKey]
                                    )
                                  }
                                >
                                  {label}
                                </button>
                              </div>
                            );
                          }
                          return (
                            <button
                              key={group.groupKey}
                              className="btn-sm"
                              type="button"
                              disabled={!values[feature.key]}
                              onClick={() =>
                                setExpandedGroups((prev) =>
                                  prev.includes(group.groupKey)
                                    ? prev.filter((key) => key !== group.groupKey)
                                    : [...prev, group.groupKey]
                                )
                              }
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {FEATURE_GROUPS.map((group) => {
                if (!values[group.tabKey] || !expandedGroups.includes(group.groupKey)) return null;
                const isCreationGroup = group.tabKey === "tab.creation";
                const groupEnabled = values[group.groupKey];
                return (
                  <section
                    className={"permission-section" + (isCreationGroup && !groupEnabled ? " permission-group-disabled" : "")}
                    key={group.groupKey}
                  >
                    <div className="permission-section-title-row">
                      <div className="permission-section-title">{group.sectionTitle}</div>
                      {isCreationGroup ? (
                        <label className="permission-section-toggle">
                          <input
                            type="checkbox"
                            checked={groupEnabled}
                            onChange={(e) => handleGroupToggle(group, e.target.checked)}
                          />
                          <span>{groupEnabled ? "显示该模块" : "隐藏该模块"}</span>
                        </label>
                      ) : null}
                    </div>
                    <div className="permission-check-grid">
                      {group.features.map((feature) => (
                        <label
                          className={"permission-check-item" + (isCreationGroup && !groupEnabled ? " disabled" : "")}
                          key={feature.key}
                        >
                          <input
                            type="checkbox"
                            checked={values[feature.key]}
                            disabled={isCreationGroup && !groupEnabled}
                            onChange={(e) =>
                              setValues((prev) => ({ ...prev, [feature.key]: e.target.checked }))
                            }
                          />
                          <span>
                            <span className="permission-check-label">{feature.label}</span>
                            <span className="permission-check-hint">{feature.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
        <div className="card-footer">
          <span className="text-muted">桌面端会实时接收该配置变更；路由/hash 也会做兜底拦截。</span>
          <button className="btn btn-primary" disabled={saving || loading} onClick={() => void save()}>
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>
      </div>

      {notice ? (
        <div className="toast-container">
          <div className="toast toast-success">
            <div className="toast-content">
              <div className="toast-title">保存成功</div>
              <div className="toast-message">{notice}</div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
