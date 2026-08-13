"use client";

import { FormEvent, useState } from "react";
import { AlertTriangle, Pencil, Plus, Save, Trash2, X } from "lucide-react";
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
  "mathmind",
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

async function insertAuditLog(
  action: string,
  target: string,
  metadata: Record<string, unknown>
): Promise<string | null> {
  try {
    const supabase = createAdminBrowserClient();
    const { data: auth, error: userError } = await supabase.auth.getUser();
    if (userError || !auth.user) return null;
    const { error } = await supabase.from("audit_logs").insert({
      admin_user_id: auth.user.id,
      action,
      target,
      metadata
    });
    if (error) return error.message;
    return null;
  } catch {
    return "审计日志写入失败。";
  }
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
}

export function ProviderManager({ providers: initialProviders }: { providers: ProviderRow[] }) {
  const [providers, setProviders] = useState(() => sortProviders(initialProviders));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<ToggleMessage | null>(null);
  const [editing, setEditing] = useState<ProviderRow | null>(null);
  const [deleting, setDeleting] = useState<ProviderRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);

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

      try {
        const { data: auth, error: userError } = await supabase.auth.getUser();
        if (!userError && auth.user) {
          const { error: auditError } = await supabase.from("audit_logs").insert({
            admin_user_id: auth.user.id,
            action: "provider.toggle_enabled",
            target: `providers:${provider.id}`,
            metadata: {
              provider_id: provider.id,
              enabled: nextEnabled
            }
          });

          if (auditError) {
            setMessage({
              tone: "warning",
              text: `已${nextEnabled ? "启用" : "停用"} ${provider.name}，但审计日志写入失败：${auditError.message}`
            });
          }
        }
      } catch {
        setMessage({
          tone: "warning",
          text: `已${nextEnabled ? "启用" : "停用"} ${provider.name}，但审计日志写入失败。`
        });
      }
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
      const { error } = await supabase
        .from("providers")
        .update({
          name,
          auth_type: values.auth_type,
          unit_name: values.unit_name,
          default_daily_quota: values.default_daily_quota,
          equivalent_count_divisor: values.equivalent_count_divisor,
          enabled: values.enabled
        })
        .eq("id", editing.id);

      if (error) throw error;

      setProviders((prev) =>
        prev.map((row) =>
          row.id === editing.id
            ? {
                ...row,
                name,
                auth_type: values.auth_type,
                unit_name: values.unit_name,
                default_daily_quota: values.default_daily_quota,
                equivalent_count_divisor: values.equivalent_count_divisor,
                enabled: values.enabled
              }
            : row
        )
      );

      const auditWarning = await insertAuditLog("provider.update", `providers:${editing.id}`, {
        provider_id: editing.id,
        name,
        auth_type: values.auth_type,
        unit_name: values.unit_name,
        default_daily_quota: values.default_daily_quota,
        equivalent_count_divisor: values.equivalent_count_divisor,
        enabled: values.enabled
      });

      setMessage(
        auditWarning
          ? { tone: "warning", text: `已更新 ${name}，但${auditWarning}` }
          : { tone: "success", text: `已更新 ${name}。` }
      );
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

  async function confirmDelete() {
    if (!deleting) return;

    setDeletingBusy(true);
    setMessage(null);

    try {
      const supabase = createAdminBrowserClient();
      const { error } = await supabase.from("providers").delete().eq("id", deleting.id);
      if (error) throw error;

      setProviders((prev) => prev.filter((row) => row.id !== deleting.id));

      const auditWarning = await insertAuditLog("provider.delete", `providers:${deleting.id}`, {
        provider_id: deleting.id,
        name: deleting.name
      });

      setMessage(
        auditWarning
          ? { tone: "warning", text: `已删除 ${deleting.name}，但${auditWarning}` }
          : { tone: "success", text: `已删除 ${deleting.name}。` }
      );
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
          <button className="btn btn-secondary btn-sm" type="button" disabled>
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

      {providers.length === 0 ? (
        <div className="card">
          <div className="card-body">暂无 Provider 数据</div>
        </div>
      ) : (
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
              {providers.map((provider) => (
                <ProviderRowItem
                  key={provider.id}
                  provider={provider}
                  busy={busyId === provider.id}
                  onToggle={() => toggleProvider(provider)}
                  onEdit={() => setEditing(provider)}
                  onDelete={() => setDeleting(provider)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

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
  const enabled = provider.enabled;

  return (
    <tr style={{ opacity: enabled ? 1 : 0.68 }}>
      <td>
        <div className="provider-cell-name">
          <span className="provider-icon-box" style={{ background: "#EFF6FF" }}>
            {IconComp ? <IconComp size={20} /> : <span>{provider.name.slice(0, 1)}</span>}
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

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSave({
      name,
      auth_type: authType,
      unit_name: unitName,
      default_daily_quota: Number(defaultDailyQuota) || 0,
      equivalent_count_divisor: Number(equivalentCountDivisor) || 1,
      enabled
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
