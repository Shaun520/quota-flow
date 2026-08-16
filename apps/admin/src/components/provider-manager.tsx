"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Pencil, Plus, Save, Trash2, Upload, X } from "lucide-react";
import { createAdminBrowserClient } from "@/lib/supabase/client";
import { PROVIDER_ICONS } from "./provider-icons";

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
  "jimeng",
  "qwenwan",
  "yuanbao",
  "kling",
  "hailuo",
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
  onDelete
}: {
  provider: ProviderRow;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
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
