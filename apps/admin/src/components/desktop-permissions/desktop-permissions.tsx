"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck } from "lucide-react";
import { createAdminBrowserClient } from "@/lib/supabase/client";
import { listTeamOptions, type TeamOption } from "@/lib/api/teams";
import { insertAuditLog } from "@/lib/utils/audit";
import {
  applyRows,
  DEFAULT_VALUES,
  MAIN_TAB_KEYS,
  PERMISSION_FEATURE_KEYS,
  PERMISSION_MODULES
} from "./permission-data";
import type { FeatureKey, PermissionRow, PermissionSubGroup, PermissionValues, Scope } from "./types";
import { PermissionScopeSelect } from "./permission-scope-select";
import { PermissionBatchActions } from "./permission-batch-actions";
import { PermissionModuleNav } from "./permission-module-nav";
import { PermissionModulePanel } from "./permission-module-panel";

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

export function DesktopPermissionsPage() {
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [scopeKey, setScopeKey] = useState("global");
  const [values, setValues] = useState<PermissionValues>(() => ({ ...DEFAULT_VALUES }));
  const [initialValues, setInitialValues] = useState<PermissionValues>(() => ({ ...DEFAULT_VALUES }));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedModuleKey, setSelectedModuleKey] = useState<string>(PERMISSION_MODULES[0].key);

  const selectedModule = useMemo(
    () => PERMISSION_MODULES.find((module) => module.key === selectedModuleKey) ?? PERMISSION_MODULES[0],
    [selectedModuleKey]
  );

  const scope = useMemo<Scope>(() => {
    if (scopeKey.startsWith("team:")) {
      const id = scopeKey.slice("team:".length);
      const team = teams.find((t) => t.id === id);
      return { kind: "team", id, label: team ? `团队：${team.name}` : "团队" };
    }
    return { kind: "global", id: null, label: "全局默认" };
  }, [scopeKey, teams]);

  const hasUnsavedChanges = useMemo(
    () => PERMISSION_FEATURE_KEYS.some((key) => values[key] !== initialValues[key]),
    [values, initialValues]
  );

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
      const next = applyRows({ ...DEFAULT_VALUES }, rows);
      setValues(next);
      setInitialValues(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "权限配置加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleToggleFeature = useCallback((key: FeatureKey, checked: boolean) => {
    setValues((prev) => ({ ...prev, [key]: checked }));
  }, []);

  const handleToggleSubGroup = useCallback((group: PermissionSubGroup, checked: boolean) => {
    setValues((prev) => {
      const next = { ...prev, [group.key]: checked };
      for (const feature of group.features) {
        next[feature.key] = checked;
      }
      return next;
    });
  }, []);

  const handleEnableAll = useCallback(() => {
    setValues((prev) => {
      const next = { ...prev };
      for (const key of PERMISSION_FEATURE_KEYS) next[key] = true;
      return next;
    });
  }, []);

  const handleDisableAll = useCallback(() => {
    const confirmed = window.confirm(
      "确定要关闭当前作用域下的所有开关吗？\n关闭所有主 Tab 会导致桌面端没有可用模块，保存时将无法通过校验。"
    );
    if (!confirmed) return;
    setValues((prev) => {
      const next = { ...prev };
      for (const key of PERMISSION_FEATURE_KEYS) next[key] = false;
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    void loadPermissions(scope);
  }, [loadPermissions, scope]);

  const save = useCallback(async () => {
    if (!MAIN_TAB_KEYS.some((key) => values[key])) {
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

      await insertAuditLog("desktop_permissions.update", {
        teamId: scope.kind === "team" ? scope.id : null,
        target: scope.kind === "team" ? scope.id : null,
        metadata: {
          targetType: scope.kind,
          targetId: scope.id,
          disabledKeys: PERMISSION_FEATURE_KEYS.filter((key) => !values[key]),
          enabledKeys: PERMISSION_FEATURE_KEYS.filter((key) => values[key])
        }
      });

      setInitialValues({ ...values });
      setNotice(`已保存：${scope.label}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "权限配置保存失败");
    } finally {
      setSaving(false);
    }
  }, [scope, values]);

  const saveRef = useRef(save);
  saveRef.current = save;

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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">权限控制</h1>
          <p className="page-subtitle">控制桌面端主 Tab 与主 Tab 下的功能显示开关</p>
        </div>
        <div className="page-actions">
          <PermissionScopeSelect teams={teams} value={scopeKey} disabled={loading} onChange={setScopeKey} />
          <PermissionBatchActions
            disabled={loading || saving}
            onEnableAll={handleEnableAll}
            onDisableAll={handleDisableAll}
            onReset={handleReset}
          />
          {hasUnsavedChanges ? (
            <span className="badge badge-warning">
              <span className="badge-dot" />
              有未保存更改
            </span>
          ) : null}
          <button
            className="btn btn-primary"
            disabled={saving || loading}
            title="保存配置（Ctrl+S）"
            onClick={() => void save()}
          >
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger">
          <svg
            className="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="card">
          <div className="card-body">
            <div className="empty-state">正在加载权限配置...</div>
          </div>
        </div>
      ) : (
        <>
          <div className="permission-workspace">
            <PermissionModuleNav
              modules={PERMISSION_MODULES}
              values={values}
              selectedKey={selectedModuleKey}
              onSelect={setSelectedModuleKey}
              onToggleTab={handleToggleFeature}
            />
            <PermissionModulePanel
              module={selectedModule}
              values={values}
              onToggleTab={handleToggleFeature}
              onToggleFeature={handleToggleFeature}
              onToggleSubGroup={handleToggleSubGroup}
            />
          </div>
          <p className="text-muted permission-footer-note">
            当前作用域：{scope.label}。桌面端会实时接收配置变更；路由/hash 也会做兜底拦截。保存快捷键 Ctrl+S。
          </p>
        </>
      )}

      {notice ? (
        <div className="toast-container">
          <div className="toast toast-success">
            <CircleCheck className="toast-icon" />
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
