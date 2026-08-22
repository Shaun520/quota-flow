"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, ListChecks, Pencil, Plus, Save, Trash2, Upload, X } from "lucide-react";
import { createAdminBrowserClient } from "@/lib/supabase/client";
import { insertAuditLog } from "@/lib/utils/audit";
import { PROVIDER_ICONS } from "./provider-icons";
import { listTeamOptions, type TeamOption } from "@/lib/api/teams";
import { MODE_LABELS, PROVIDER_GENERATION_CATALOG } from "@/lib/provider-catalog";

export interface ProviderRow {
  id: string;
  name: string;
  logo: string | null;
  capabilities: Record<string, unknown> | null;
  auth_type: string;
  enabled: boolean;
  unit_name: string | null;
  default_daily_quota: number | null;
  equivalent_count_divisor: number | null;
}

const PROVIDER_ORDER = [
  "doubao",
  "qwenwan",
  "yuanbao",
  "qwen"
];

function providerOrderIndex(id: string): number {
  const index = PROVIDER_ORDER.indexOf(id);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

function sortProviders(rows: ProviderRow[]): ProviderRow[] {
  return [...rows].sort((a, b) => {
    const ai = providerOrderIndex(a.id);
    const bi = providerOrderIndex(b.id);
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}

function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return Number(value).toLocaleString("zh-CN");
}

function isRemoteLogo(logo: string | null | undefined): logo is string {
  return typeof logo === "string" && /^(https?:\/\/|data:image\/)/i.test(logo);
}

function storagePathFromLogoUrl(logo: string | null | undefined): string | null {
  if (!logo) return null;
  const marker = "/provider-logos/";
  const index = logo.indexOf(marker);
  if (index === -1) return null;
  const path = logo.slice(index + marker.length);
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

async function uploadProviderLogo(providerId: string, file: File): Promise<string> {
  const supabase = createAdminBrowserClient();
  const ext =
    (file.name.split(".").pop() || "png")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase() || "png";
  const storagePath = `${providerId}-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("provider-logos")
    .upload(storagePath, file, {
      cacheControl: "3600",
      contentType: file.type || undefined,
      upsert: true
    });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabase.storage
    .from("provider-logos")
    .getPublicUrl(storagePath);

  return publicUrlData.publicUrl;
}

interface ToggleMessage {
  tone: "success" | "danger" | "warning";
  text: string;
}

interface ProviderEditValues {
  name: string;
  auth_type: string;
  unit_name: string;
  default_daily_quota: number;
  equivalent_count_divisor: number;
  enabled: boolean;
  logoFile?: File | null;
  logoRemoved?: boolean;
}

interface ProviderCreateValues extends ProviderEditValues {
  id: string;
  logoFile?: File | null;
}

export function ProviderManager({ providers: initialProviders }: { providers: ProviderRow[] }) {
  const [providers, setProviders] = useState(() => sortProviders(initialProviders));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "enabled" | "disabled">("");
  const [authFilter, setAuthFilter] = useState<"" | "cookie" | "apikey">("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<ToggleMessage | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProviderRow | null>(null);
  const [deleting, setDeleting] = useState<ProviderRow | null>(null);
  const [capsProvider, setCapsProvider] = useState<ProviderRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = createAdminBrowserClient();
      const { data, error } = await supabase
        .from("providers")
        .select("id, name, logo, capabilities, auth_type, enabled, unit_name, default_daily_quota, equivalent_count_divisor");
      if (error) throw error;
      setProviders(sortProviders((data ?? []) as ProviderRow[]));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载 Provider 数据失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const filteredProviders = providers.filter((provider) => {
    const query = search.trim().toLowerCase();
    const matchesSearch =
      !query ||
      provider.name.toLowerCase().includes(query) ||
      provider.id.toLowerCase().includes(query);
    const matchesStatus =
      !statusFilter || (statusFilter === "enabled" ? provider.enabled : !provider.enabled);
    const matchesAuth = !authFilter || provider.auth_type === authFilter;
    return matchesSearch && matchesStatus && matchesAuth;
  });

  async function toggleProvider(provider: ProviderRow) {
    const nextEnabled = !provider.enabled;
    setBusyId(provider.id);
    setMessage(null);

    try {
      const supabase = createAdminBrowserClient();
      const { error: updateError } = await supabase
        .from("providers")
        .update({ enabled: nextEnabled })
        .eq("id", provider.id);

      if (updateError) throw updateError;

      setProviders((prev) =>
        prev.map((row) => (row.id === provider.id ? { ...row, enabled: nextEnabled } : row))
      );

      setMessage({ tone: "success", text: `已${nextEnabled ? "启用" : "停用"} ${provider.name}。` });

      await insertAuditLog("provider.toggle_enabled", {
        target: provider.id,
        metadata: { provider_id: provider.id, enabled: nextEnabled }
      });
    } catch (e) {
      setMessage({
        tone: "danger",
        text: e instanceof Error ? `操作失败：${e.message}` : "操作失败，请稍后重试。"
      });
    } finally {
      setBusyId(null);
    }
  }

  async function saveProvider(values: ProviderEditValues) {
    if (!editing) return;

    const name = values.name.trim();
    if (!name) {
      setMessage({ tone: "danger", text: "厂商名称不能为空。" });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const supabase = createAdminBrowserClient();
      const baseUpdate = {
        name,
        auth_type: values.auth_type,
        unit_name: values.unit_name,
        default_daily_quota: values.default_daily_quota,
        equivalent_count_divisor: values.equivalent_count_divisor,
        enabled: values.enabled
      };

      let logo: string | null = editing.logo;
      if (values.logoRemoved) {
        logo = null;
      } else if (values.logoFile) {
        logo = await uploadProviderLogo(editing.id, values.logoFile);
      }

      const { error } = await supabase
        .from("providers")
        .update({
          ...baseUpdate,
          ...(values.logoRemoved || values.logoFile ? { logo } : {})
        })
        .eq("id", editing.id);

      if (error) throw error;

      if (values.logoFile || values.logoRemoved) {
        const oldPath = storagePathFromLogoUrl(editing.logo);
        const newPath = values.logoFile ? storagePathFromLogoUrl(logo) : null;
        if (oldPath && (!newPath || oldPath !== newPath)) {
          try {
            await supabase.storage.from("provider-logos").remove([oldPath]);
          } catch {
            // Removing the old storage file is best effort; the DB row is already updated.
          }
        }
      }

      setProviders((prev) =>
        prev.map((row) =>
          row.id === editing.id
            ? {
                ...row,
                ...baseUpdate,
                ...(values.logoRemoved || values.logoFile ? { logo } : {})
              }
            : row
        )
      );

      await insertAuditLog("provider.update", {
        target: editing.id,
        metadata: {
          provider_id: editing.id,
          name,
          auth_type: values.auth_type,
          unit_name: values.unit_name,
          default_daily_quota: values.default_daily_quota,
          equivalent_count_divisor: values.equivalent_count_divisor,
          enabled: values.enabled
        }
      });

      setMessage({ tone: "success", text: `已更新 ${name}。` });
      setEditing(null);
    } catch (e) {
      setMessage({
        tone: "danger",
        text: e instanceof Error ? `操作失败：${e.message}` : "操作失败，请稍后重试。"
      });
    } finally {
      setSaving(false);
    }
  }

  async function createProvider(values: ProviderCreateValues) {
    const id = values.id.trim().toLowerCase();
    const name = values.name.trim();
    if (!id) {
      setMessage({ tone: "danger", text: "Provider ID 不能为空。" });
      return;
    }
    if (!/^[a-z0-9_]+$/.test(id)) {
      setMessage({ tone: "danger", text: "Provider ID 只能包含小写字母、数字和下划线。" });
      return;
    }
    if (!name) {
      setMessage({ tone: "danger", text: "厂商名称不能为空。" });
      return;
    }
    if (providers.some((row) => row.id === id)) {
      setMessage({ tone: "danger", text: `Provider ID 已存在：${id}` });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const supabase = createAdminBrowserClient();
      const { error } = await supabase.from("providers").insert({
        id,
        name,
        logo: null,
        capabilities: null,
        auth_type: values.auth_type,
        unit_name: values.unit_name,
        default_daily_quota: values.default_daily_quota,
        equivalent_count_divisor: values.equivalent_count_divisor,
        enabled: values.enabled
      });

      if (error) throw error;

      let logo: string | null = null;
      if (values.logoFile) {
        try {
          logo = await uploadProviderLogo(id, values.logoFile);
        } catch (uploadError) {
          await supabase.from("providers").delete().eq("id", id);
          throw uploadError;
        }

        const { error: logoUpdateError } = await supabase
          .from("providers")
          .update({ logo })
          .eq("id", id);

        if (logoUpdateError) {
          const oldPath = storagePathFromLogoUrl(logo);
          if (oldPath) {
            await supabase.storage.from("provider-logos").remove([oldPath]);
          }
          await supabase.from("providers").delete().eq("id", id);
          throw logoUpdateError;
        }
      }

      const newRow: ProviderRow = {
        id,
        name,
        logo,
        capabilities: null,
        auth_type: values.auth_type,
        unit_name: values.unit_name,
        default_daily_quota: values.default_daily_quota,
        equivalent_count_divisor: values.equivalent_count_divisor,
        enabled: values.enabled
      };
      setProviders((prev) => sortProviders([...prev, newRow]));

      await insertAuditLog("provider.create", {
        target: id,
        metadata: {
          provider_id: id,
          name,
          auth_type: values.auth_type,
          unit_name: values.unit_name,
          default_daily_quota: values.default_daily_quota,
          equivalent_count_divisor: values.equivalent_count_divisor,
          enabled: values.enabled
        }
      });

      setMessage({ tone: "success", text: `已创建 ${name}。` });
      setCreating(false);
    } catch (e) {
      setMessage({
        tone: "danger",
        text: e instanceof Error ? `操作失败：${e.message}` : "操作失败，请稍后重试。"
      });
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;

    setDeletingBusy(true);
    setMessage(null);

    try {
      const supabase = createAdminBrowserClient();
      const { error } = await supabase.from("providers").delete().eq("id", deleting.id);
      if (error) throw error;

      setProviders((prev) => prev.filter((row) => row.id !== deleting.id));

      await insertAuditLog("provider.delete", {
        target: deleting.id,
        metadata: { provider_id: deleting.id, name: deleting.name }
      });

      setMessage({ tone: "success", text: `已删除 ${deleting.name}。` });
      setDeleting(null);
    } catch (e) {
      setMessage({
        tone: "danger",
        text: e instanceof Error ? `操作失败：${e.message}` : "操作失败，请稍后重试。"
      });
    } finally {
      setDeletingBusy(false);
    }
  }

  return (
    <div className="page active" id="page-providers">
      <div className="page-header">
        <div>
          <h1 className="page-title">Provider 管理</h1>
          <p className="page-subtitle">管理厂商配置、全局启用/禁用与健康监控</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setCreating(true)}>
            <Plus />
            新增 Provider
          </button>
        </div>
      </div>

      {message ? (
        <div className={`alert alert-${message.tone}`} role="status">
          {message.text}
        </div>
      ) : null}

      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">状态</span>
          <select
            className="form-select"
            style={{ width: 120 }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "" | "enabled" | "disabled")}
          >
            <option value="">全部</option>
            <option value="enabled">已启用</option>
            <option value="disabled">已停用</option>
          </select>
        </div>

        <div className="filter-group">
          <span className="filter-label">认证方式</span>
          <select
            className="form-select"
            style={{ width: 120 }}
            value={authFilter}
            onChange={(e) => setAuthFilter(e.target.value as "" | "cookie" | "apikey")}
          >
            <option value="">全部</option>
            <option value="cookie">cookie</option>
            <option value="apikey">apikey</option>
          </select>
        </div>

        <div className="filter-group" style={{ marginLeft: "auto" }}>
          <input
            type="text"
            placeholder="搜索厂商名称或 ID..."
            style={{ width: 220 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="table-container">
        <table className="table provider-table">
          <thead>
            <tr>
              <th>厂商</th>
              <th>认证方式</th>
              <th>单位</th>
              <th>等效除数</th>
              <th>默认日额度</th>
              <th>成功率</th>
              <th>状态</th>
              <th style={{ textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && providers.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty-state" style={{ textAlign: "center" }}>
                  加载中...
                </td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan={8} className="empty-state" style={{ textAlign: "center", color: "var(--color-destructive)" }}>
                  {loadError}
                </td>
              </tr>
            ) : filteredProviders.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty-state" style={{ textAlign: "center" }}>
                  暂无匹配的 Provider
                </td>
              </tr>
            ) : (
              filteredProviders.map((provider) => (
                <ProviderRowItem
                  key={provider.id}
                  provider={provider}
                  busy={busyId === provider.id}
                  onToggle={() => toggleProvider(provider)}
                  onEdit={() => setEditing(provider)}
                  onDelete={() => setDeleting(provider)}
                  onCaps={() => setCapsProvider(provider)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {creating ? (
        <ProviderCreateModal
          busy={saving}
          onSave={createProvider}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {editing ? (
        <ProviderEditModal
          provider={editing}
          busy={saving}
          onSave={saveProvider}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {deleting ? (
        <ProviderDeleteModal
          provider={deleting}
          busy={deletingBusy}
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        />
      ) : null}

      {capsProvider ? (
        <ProviderCapsModal provider={capsProvider} onClose={() => setCapsProvider(null)} />
      ) : null}
    </div>
  );
}

function ProviderCreateModal({
  busy,
  onSave,
  onClose
}: {
  busy: boolean;
  onSave: (values: ProviderCreateValues) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState("cookie");
  const [unitName, setUnitName] = useState("");
  const [defaultDailyQuota, setDefaultDailyQuota] = useState("0");
  const [equivalentCountDivisor, setEquivalentCountDivisor] = useState("1");
  const [enabled, setEnabled] = useState(true);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSave({
      id,
      name,
      auth_type: authType,
      unit_name: unitName,
      default_daily_quota: Number(defaultDailyQuota) || 0,
      equivalent_count_divisor: Number(equivalentCountDivisor) || 1,
      enabled,
      logoFile
    });
  }

  function handleLogoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setLogoFile(file);
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    setLogoPreview(file ? URL.createObjectURL(file) : null);
  }

  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">新增 Provider</div>
          <button className="modal-close" type="button" onClick={onClose} disabled={busy} aria-label="关闭">
            <X />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">
                Provider ID<span className="required">*</span>
              </label>
              <input
                className="form-input"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="doubao"
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">
                厂商名称<span className="required">*</span>
              </label>
              <input
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">图标上传</label>
              <label className="logo-upload-control">
                <Upload size={16} />
                <span>{logoFile ? "已选择图标" : "选择图标文件"}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  onChange={handleLogoChange}
                  disabled={busy}
                />
              </label>
              <p className="form-hint">上传后保存到 Supabase Storage，公网可访问。</p>
              {logoPreview ? (
                <div className="logo-upload-preview">
                  <img src={logoPreview} alt="" />
                  <span>{logoFile?.name}</span>
                </div>
              ) : null}
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">认证方式</label>
                <select
                  className="form-select"
                  value={authType}
                  onChange={(e) => setAuthType(e.target.value)}
                >
                  <option value="cookie">cookie</option>
                  <option value="apikey">apikey</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">额度单位</label>
                <input
                  className="form-input"
                  value={unitName}
                  onChange={(e) => setUnitName(e.target.value)}
                  placeholder="count"
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">默认日额度</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  step="1"
                  value={defaultDailyQuota}
                  onChange={(e) => setDefaultDailyQuota(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">等效除数</label>
                <input
                  className="form-input"
                  type="number"
                  min="1"
                  step="1"
                  value={equivalentCountDivisor}
                  onChange={(e) => setEquivalentCountDivisor(e.target.value)}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">启用状态</label>
              <label className="toggle" title={enabled ? "已启用" : "已停用"}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div className="modal-footer">
            <button className="btn btn-secondary btn-sm" type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
              <Plus />
              {busy ? "保存中..." : "新增"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProviderRowItem({
  provider,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onCaps
}: {
  provider: ProviderRow;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCaps: () => void;
}) {
  const IconComp = PROVIDER_ICONS[provider.id];
  const logoUrl = isRemoteLogo(provider.logo) ? provider.logo : null;
  const enabled = provider.enabled;

  return (
    <tr style={{ opacity: enabled ? 1 : 0.68 }}>
      <td>
        <div className="provider-cell-name">
          <span className="provider-icon-box" style={{ background: "#EFF6FF" }}>
            {logoUrl ? (
              <img className="provider-icon-img" src={logoUrl} alt={provider.name} />
            ) : IconComp ? (
              <IconComp size={20} />
            ) : (
              <span>{provider.name.slice(0, 1)}</span>
            )}
          </span>
          <span>
            <div className="provider-name">{provider.name}</div>
            <div className="provider-id">{provider.id}</div>
          </span>
        </div>
      </td>
      <td>
        <span className="badge badge-muted">{provider.auth_type || "cookie"}</span>
      </td>
      <td className="cell-mono">{provider.unit_name || "count"}</td>
      <td className="cell-mono">{formatNumber(provider.equivalent_count_divisor)}</td>
      <td className="cell-mono">{formatNumber(provider.default_daily_quota)}</td>
      <td>
        <span className="badge badge-warning">待统计</span>
      </td>
      <td>
        <span className={`badge ${enabled ? "badge-success" : "badge-muted"}`}>
          <span className="badge-dot"></span>
          {enabled ? "已启用" : "已停用"}
        </span>
      </td>
      <td>
        <div className="cell-actions">
          <label className="toggle" title={enabled ? "停用" : "启用"}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={onToggle}
            />
            <span className="toggle-slider"></span>
          </label>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={onEdit}>
            <Pencil size={14} />
            编辑
          </button>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={onCaps}>
            <ListChecks size={14} />
            生成能力
          </button>
          <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={onDelete}>
            <Trash2 size={14} />
            删除
          </button>
        </div>
      </td>
    </tr>
  );
}

function ProviderEditModal({
  provider,
  busy,
  onSave,
  onClose
}: {
  provider: ProviderRow;
  busy: boolean;
  onSave: (values: ProviderEditValues) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(provider.name);
  const [authType, setAuthType] = useState(provider.auth_type);
  const [unitName, setUnitName] = useState(provider.unit_name ?? "");
  const [defaultDailyQuota, setDefaultDailyQuota] = useState(String(provider.default_daily_quota ?? 0));
  const [equivalentCountDivisor, setEquivalentCountDivisor] = useState(
    String(provider.equivalent_count_divisor ?? 1)
  );
  const [enabled, setEnabled] = useState(provider.enabled);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoRemoved, setLogoRemoved] = useState(false);

  const hasExistingLogo = isRemoteLogo(provider.logo);

  function handleLogoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setLogoFile(file);
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    setLogoPreview(file ? URL.createObjectURL(file) : null);
    setLogoRemoved(false);
  }

  function handleRemoveLogo() {
    setLogoFile(null);
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    setLogoPreview(null);
    setLogoRemoved(true);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSave({
      name,
      auth_type: authType,
      unit_name: unitName,
      default_daily_quota: Number(defaultDailyQuota) || 0,
      equivalent_count_divisor: Number(equivalentCountDivisor) || 1,
      enabled,
      logoFile,
      logoRemoved
    });
  }

  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">编辑 Provider</div>
          <button className="modal-close" type="button" onClick={onClose} disabled={busy} aria-label="关闭">
            <X />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">Provider ID</label>
              <input className="form-input" value={provider.id} disabled />
            </div>

            <div className="form-group">
              <label className="form-label">
                厂商名称<span className="required">*</span>
              </label>
              <input
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">图标上传</label>
              {logoPreview || (hasExistingLogo && !logoRemoved) ? (
                <div className="logo-upload-preview">
                  <img src={logoPreview ?? provider.logo ?? ""} alt={provider.name} />
                  <span>
                    {logoFile
                      ? logoFile.name
                      : "当前图标"}
                  </span>
                </div>
              ) : null}
              {logoRemoved ? <p className="form-hint">已选择移除图标，保存后生效。</p> : null}
              <label className="logo-upload-control">
                <Upload size={16} />
                <span>{logoFile ? "已选择新图标" : "选择图标文件"}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  onChange={handleLogoChange}
                  disabled={busy}
                />
              </label>
              {(hasExistingLogo && !logoRemoved) || logoFile ? (
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={busy}
                  onClick={handleRemoveLogo}
                >
                  <X size={14} />
                  移除图标
                </button>
              ) : null}
              <p className="form-hint">选择新文件后保存会替换当前图标，公网可访问。</p>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">认证方式</label>
                <select
                  className="form-select"
                  value={authType}
                  onChange={(e) => setAuthType(e.target.value)}
                >
                  <option value="cookie">cookie</option>
                  <option value="apikey">apikey</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">额度单位</label>
                <input
                  className="form-input"
                  value={unitName}
                  onChange={(e) => setUnitName(e.target.value)}
                  placeholder="count"
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">默认日额度</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  step="1"
                  value={defaultDailyQuota}
                  onChange={(e) => setDefaultDailyQuota(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">等效除数</label>
                <input
                  className="form-input"
                  type="number"
                  min="1"
                  step="1"
                  value={equivalentCountDivisor}
                  onChange={(e) => setEquivalentCountDivisor(e.target.value)}
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">启用状态</label>
              <label className="toggle" title={enabled ? "已启用" : "已停用"}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div className="modal-footer">
            <button className="btn btn-secondary btn-sm" type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
              <Save />
              {busy ? "保存中..." : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProviderDeleteModal({
  provider,
  busy,
  onConfirm,
  onClose
}: {
  provider: ProviderRow;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">删除 Provider</div>
          <button className="modal-close" type="button" onClick={onClose} disabled={busy} aria-label="关闭">
            <X />
          </button>
        </div>
        <div className="modal-body">
          <div className="alert alert-danger">
            <AlertTriangle />
            <span>
              确认删除 {provider.name}（{provider.id}）？该操作会同步删除该厂商的绑定账号、额度账本和消耗表规则。
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary btn-sm" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-danger btn-sm" type="button" onClick={onConfirm} disabled={busy}>
            <Trash2 />
            {busy ? "删除中..." : "确认删除"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface CapsRow {
  modes: string[];
  models: string[];
}

function ProviderCapsModal({ provider, onClose }: { provider: ProviderRow; onClose: () => void }) {
  const catalog = PROVIDER_GENERATION_CATALOG[provider.id] ?? { modes: [], models: [] };
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [scopeKind, setScopeKind] = useState<"global" | "team">("global");
  const [teamId, setTeamId] = useState("");
  const [selectedModes, setSelectedModes] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetId = scopeKind === "team" ? teamId : null;

  const loadCaps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createAdminBrowserClient();
      let query = supabase
        .from("provider_caps")
        .select("modes, models")
        .eq("provider", provider.id)
        .eq("target_type", scopeKind);
      query = scopeKind === "team" ? query.eq("target_id", teamId) : query.is("target_id", null);
      const { data, error: qError } = await query.maybeSingle();
      if (qError) throw qError;
      const row = (data ?? null) as CapsRow | null;
      setSelectedModes(row?.modes ?? []);
      setSelectedModels(row?.models ?? []);
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : (e as { message?: string } | undefined)?.message || String(e);
      setError(msg || "配置加载失败");
    } finally {
      setLoading(false);
    }
  }, [provider.id, scopeKind, teamId]);

  useEffect(() => {
    void listTeamOptions().then(setTeams).catch(() => {});
  }, []);

  useEffect(() => {
    // team 范围尚未选择团队时不加载（避免与 global 的 null target 冲突）
    if (scopeKind === "team" && !teamId) {
      setSelectedModes([]);
      setSelectedModels([]);
      return;
    }
    void loadCaps();
  }, [scopeKind, teamId, loadCaps]);

  function toggleMode(mode: string, checked: boolean) {
    setSelectedModes((prev) => (checked ? [...prev, mode] : prev.filter((m) => m !== mode)));
  }
  function toggleModel(model: string, checked: boolean) {
    setSelectedModels((prev) => (checked ? [...prev, model] : prev.filter((m) => m !== model)));
  }

  async function handleSave() {
    if (scopeKind === "team" && !teamId) {
      setError("请先选择团队");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const supabase = createAdminBrowserClient();
      const {
        data: { user }
      } = await supabase.auth.getUser();
      const adminId = user?.id ?? null;

      let del = supabase
        .from("provider_caps")
        .delete()
        .eq("provider", provider.id)
        .eq("target_type", scopeKind);
      del = scopeKind === "team" ? del.eq("target_id", teamId) : del.is("target_id", null);
      const { error: delError } = await del;
      if (delError) throw delError;

      const { error: insError } = await supabase.from("provider_caps").insert({
        target_type: scopeKind,
        target_id: targetId,
        provider: provider.id,
        modes: selectedModes,
        models: selectedModels,
        updated_by: adminId
      });
      if (insError) throw insError;

      await insertAuditLog("providerCaps.upsert", {
        target: provider.id,
        metadata: {
          provider_id: provider.id,
          targetType: scopeKind,
          targetId: targetId,
          modes: selectedModes,
          models: selectedModels
        }
      });

      onClose();
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : (e as { message?: string } | undefined)?.message || String(e);
      setError(msg || "配置保存失败");
    } finally {
      setSaving(false);
    }
  }

  const scopeLabel = scopeKind === "team" ? `团队：${teams.find((t) => t.id === teamId)?.name ?? "未选择"}` : "全局默认";

  return (
    <div className="modal-overlay show" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">
            生成能力 · {provider.name}
          </div>
          <button className="modal-close" type="button" onClick={onClose} disabled={saving} aria-label="关闭">
            <X />
          </button>
        </div>
        <div className="modal-body">
          <p className="form-hint">
            配置后桌面端该厂商的模式/模型以勾选项为唯一可选；全不勾选＝屏蔽该厂商；该作用域未配置＝桌面端默认值。
          </p>

          <div className="form-group">
            <label className="form-label">作用范围</label>
            <div className="provider-cap-scope">
              <label className={scopeKind === "global" ? "cap-option active" : "cap-option"}>
                <input
                  type="radio"
                  name="caps-scope"
                  checked={scopeKind === "global"}
                  onChange={() => setScopeKind("global")}
                />
                全局默认
              </label>
              <label className={scopeKind === "team" ? "cap-option active" : "cap-option"}>
                <input
                  type="radio"
                  name="caps-scope"
                  checked={scopeKind === "team"}
                  onChange={() => setScopeKind("team")}
                />
                指定团队
              </label>
            </div>
          </div>

          {scopeKind === "team" ? (
            <div className="form-group">
              <label className="form-label">选择团队</label>
              <select
                className="form-select"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
              >
                <option value="">请选择团队</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {loading ? (
            <p className="form-hint">加载配置中...</p>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label">
                  生成模式（<span style={{ color: "var(--color-destructive)" }}>暂存为 {scopeLabel}</span>）
                </label>
                <div className="cap-checkbox-group">
                  {catalog.modes.length === 0 ? (
                    <p className="form-hint">该厂商暂无模式目录</p>
                  ) : (
                    catalog.modes.map((mode) => (
                      <label key={mode} className="cap-checkbox">
                        <input
                          type="checkbox"
                          checked={selectedModes.includes(mode)}
                          onChange={(e) => toggleMode(mode, e.target.checked)}
                        />
                        {MODE_LABELS[mode] ?? mode}
                      </label>
                    ))
                  )}
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">模型</label>
                <div className="cap-checkbox-group">
                  {catalog.models.length === 0 ? (
                    <p className="form-hint">该厂商暂无模型目录</p>
                  ) : (
                    catalog.models.map((model) => (
                      <label key={model} className="cap-checkbox">
                        <input
                          type="checkbox"
                          checked={selectedModels.includes(model)}
                          onChange={(e) => toggleModel(model, e.target.checked)}
                        />
                        {model}
                      </label>
                    ))
                  )}
                </div>
              </div>
            </>
          )}

          {error ? <div className="alert alert-danger">{error}</div> : null}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary btn-sm" type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary btn-sm" type="button" onClick={handleSave} disabled={saving || loading}>
            <Save />
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
