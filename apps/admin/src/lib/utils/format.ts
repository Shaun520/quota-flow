/** 日期/数字格式化 + 头像辅助，供后台各列表复用。 */

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = formatDate(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${date} ${hh}:${mm}`;
}

export function formatCount(n: number): string {
  return `${Math.round(n).toLocaleString("zh-CN")} 次`;
}

/** 头像缩写：中文取前两字，英文取首字母。 */
export function initials(name: string | null, email: string | null): string {
  const src = (name ?? "").trim() || (email ?? "").trim();
  if (!src) return "?";
  if (/[一-龥]/.test(src)) {
    return src.slice(0, 2);
  }
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = ["#1E40AF", "#059669", "#D97706", "#DC2626", "#7C3AED", "#0891B2", "#4F46E5"];

/** 依据 id 稳定取一个头像底色，同一用户颜色不变。 */
export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
