import type { LucideIcon } from "lucide-react";

export type FeatureKey =
  | "tab.dispatch"
  | "tab.providers"
  | "tab.history"
  | "tab.team"
  | "tab.creation"
  | "dispatch.text2video"
  | "dispatch.img2video"
  | "dispatch.multi_ref"
  | "dispatch.first_last"
  | "dispatch.first_frame"
  | "providers.bind"
  | "history.detail"
  | "history.regenerate"
  | "history.copy_prompt"
  | "history.watermark_removal"
  | "creation.ai_toolbox"
  | "creation.watermark"
  | "creation.prompt_expander"
  | "creation.storyboard"
  | "creation.video_library"
  | "creation.community"
  | "creation.material_library";

export interface PermissionFeature {
  key: FeatureKey;
  label: string;
  description: string;
}

/**
 * 模块内的二级分组（目前仅创作中心使用）。
 * key 本身是真实的 feature_key（桌面端会消费），不是纯 UI 状态。
 */
export interface PermissionSubGroup {
  key: FeatureKey;
  label: string;
  description: string;
  features: PermissionFeature[];
}

export interface PermissionModule {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  color: string;
  /** 关联的主 Tab 权限 key */
  tabKey: FeatureKey;
  features: PermissionFeature[];
  subGroups: PermissionSubGroup[];
}

export type PermissionValues = Record<FeatureKey, boolean>;

export type Scope =
  | { kind: "global"; id: null; label: string }
  | { kind: "team"; id: string; label: string };

export interface PermissionRow {
  feature_key: string;
  enabled: boolean;
}
