import { Clock, Plug, Sparkles, Users, Zap } from "lucide-react";
import type { FeatureKey, PermissionModule, PermissionValues } from "./types";

/**
 * 权限模块树：新增模块只需在此追加一个节点，
 * PERMISSION_FEATURE_KEYS / 默认值 / 页面分组均由此派生。
 */
export const PERMISSION_MODULES: PermissionModule[] = [
  {
    key: "dispatch",
    label: "调度台",
    description: "视频生成调度与各生成模式入口",
    icon: Zap,
    color: "#3B82F6",
    tabKey: "tab.dispatch",
    features: [
      { key: "dispatch.text2video", label: "文生视频", description: "调度台生成模式：文生视频" },
      { key: "dispatch.img2video", label: "图生视频", description: "调度台生成模式：图生视频" },
      { key: "dispatch.multi_ref", label: "多参考生成", description: "调度台生成模式：多参考生成" },
      { key: "dispatch.first_last", label: "首尾帧生成", description: "调度台生成模式：首尾帧生成" },
      { key: "dispatch.first_frame", label: "首帧生成", description: "调度台生成模式：首帧生成" }
    ],
    subGroups: []
  },
  {
    key: "providers",
    label: "厂商",
    description: "厂商账号绑定与管理",
    icon: Plug,
    color: "#8B5CF6",
    tabKey: "tab.providers",
    features: [{ key: "providers.bind", label: "绑定账号", description: "厂商页新增/绑定账号入口" }],
    subGroups: []
  },
  {
    key: "history",
    label: "历史",
    description: "历史记录查看与二次操作",
    icon: Clock,
    color: "#10B981",
    tabKey: "tab.history",
    features: [
      { key: "history.detail", label: "历史详情", description: "历史记录查看详情入口" },
      { key: "history.regenerate", label: "重新生成", description: "历史详情重新生成入口" },
      { key: "history.copy_prompt", label: "复制提示词", description: "历史详情复制提示词入口" },
      { key: "history.watermark_removal", label: "去水印", description: "历史记录去水印/框选/重试入口" }
    ],
    subGroups: []
  },
  {
    key: "team",
    label: "团队",
    description: "团队空间与成员协作入口",
    icon: Users,
    color: "#06B6D4",
    tabKey: "tab.team",
    features: [],
    subGroups: []
  },
  {
    key: "creation",
    label: "创作中心",
    description: "AI 工具箱与视频灵感库",
    icon: Sparkles,
    color: "#F97316",
    tabKey: "tab.creation",
    features: [],
    subGroups: [
      {
        key: "creation.ai_toolbox",
        label: "AI 工具箱",
        description: "AI 工具箱模块总开关及内部工具入口",
        features: [
          { key: "creation.watermark", label: "去水印", description: "创作中心 AI 工具箱：去水印入口" },
          {
            key: "creation.prompt_expander",
            label: "提示词扩展",
            description: "创作中心 AI 工具箱：提示词扩展（待接入）"
          },
          { key: "creation.storyboard", label: "分镜生成", description: "创作中心 AI 工具箱：分镜生成（待接入）" }
        ]
      },
      {
        key: "creation.video_library",
        label: "视频灵感库",
        description: "视频灵感库模块总开关及内容入口",
        features: [
          {
            key: "creation.community",
            label: "视频灵感库",
            description: "创作中心视频灵感库：优秀视频与参考提示词"
          }
        ]
      },
      {
        key: "creation.material_library",
        label: "素材库",
        description: "本地素材库模块总开关",
        features: []
      }
    ]
  }
];

/** 全部真实权限 key（含主 Tab、子分组与子功能），由模块树派生 */
export const PERMISSION_FEATURE_KEYS: FeatureKey[] = PERMISSION_MODULES.flatMap((module) => [
  module.tabKey,
  ...module.features.map((feature) => feature.key),
  ...module.subGroups.flatMap((group) => [group.key, ...group.features.map((feature) => feature.key)])
]);

/** 主 Tab 权限 key 列表，用于保存前的「至少保留一个主 Tab」校验 */
export const MAIN_TAB_KEYS: FeatureKey[] = PERMISSION_MODULES.map((module) => module.tabKey);

export const DEFAULT_VALUES: PermissionValues = Object.fromEntries(
  PERMISSION_FEATURE_KEYS.map((key) => [key, true])
) as PermissionValues;

export function applyRows(values: PermissionValues, rows: { feature_key: string; enabled: boolean }[]): PermissionValues {
  const next = { ...values };
  for (const row of rows) {
    if (PERMISSION_FEATURE_KEYS.includes(row.feature_key as FeatureKey)) {
      next[row.feature_key as FeatureKey] = !!row.enabled;
    }
  }
  return next;
}
