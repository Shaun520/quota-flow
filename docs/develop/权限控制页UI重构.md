# Admin 权限控制页 UI 重构

> 日期：2026-08-17
> 范围：`apps/admin/src/components/desktop-permissions/`、`apps/admin/src/app/globals.css`
> 页面：`/desktop-permissions`（管理后台 → 权限控制）

## 背景

原权限控制页为单个约 500 行的 `desktop-permissions.tsx`，权限项平铺在 `PERMISSION_FEATURE_KEYS` 数组中，UI 通过字符串前缀硬分组（`buildFeatureGroups`），新增模块需要同时改三处（keys 数组、FEATURES 数组、分组函数），且 `creation.ai_toolbox` / `creation.video_library` 两个分组 key 缺少 label/description。本次按「显式树形元数据 + 组件拆分 + 主从布局」重构。

## 关键结论：两个创作中心分组 key 是真实权限 key

`creation.ai_toolbox`、`creation.video_library` 并非纯 UI 分组状态——桌面端 `apps/desktop/src/renderer/src/components/CreationCenter.tsx` 实际消费它们控制整个模块显隐：

- `features['creation.ai_toolbox'] !== false` 控制 AI 工具箱模块显示
- `features['creation.video_library']` 控制视频灵感库模块显示

因此这两个 key **必须继续落库**。重构时将它们在元数据中显式建模为「子分组」（subGroup），补全 label/description；分组开关写入自身 key + 所有子项 key，保存时全部真实 key 一并写入 `desktop_permissions` 表。

## 最终文件结构

```
apps/admin/src/components/desktop-permissions/
├── index.ts                      # 导出 DesktopPermissionsPage，页面 import 路径不变
├── desktop-permissions.tsx       # 容器：状态管理、加载/保存、作用域、Ctrl+S、toast
├── permission-data.ts            # PERMISSION_MODULES 树形元数据 + 派生 keys/默认值/applyRows
├── types.ts                      # FeatureKey / PermissionModule / Scope 等类型
├── permission-scope-select.tsx   # 作用域选择器（自定义下拉）
├── permission-batch-actions.tsx  # 全开 / 全关 / 恢复默认
├── permission-module-nav.tsx     # 左侧模块导航（竖排列表）
├── permission-module-panel.tsx   # 右侧选中模块的子功能详情
└── permission-feature-toggle.tsx # 单个功能开关行（.toggle）
```

旧的单文件 `apps/admin/src/components/desktop-permissions.tsx` 与中间产物 `permission-card.tsx`（卡片网格版）均已删除。

## 元数据：显式树形结构

`permission-data.ts` 中 `PERMISSION_MODULES` 为唯一数据源：

```ts
interface PermissionModule {
  key: string;            // 模块标识，如 "dispatch"
  label: string;          // 显示名，如 "调度台"
  description: string;
  icon: LucideIcon;       // 模块图标
  color: string;          // 主题色
  tabKey: FeatureKey;     // 关联主 Tab 权限 key
  features: PermissionFeature[];    // 一级子功能
  subGroups: PermissionSubGroup[];  // 二级分组（仅创作中心使用）
}
```

- `PERMISSION_FEATURE_KEYS`（含主 Tab、子分组、子功能全部真实 key）、`DEFAULT_VALUES`、`MAIN_TAB_KEYS` 均由树派生
- 新增模块只需在 `PERMISSION_MODULES` 追加一个节点
- 模块主题色：调度台 `#3B82F6`（蓝）、厂商 `#8B5CF6`（紫）、历史 `#10B981`（绿）、团队 `#06B6D4`（青）、创作中心 `#F97316`（橙）

## 页面布局：左侧导航 + 右侧详情（主从结构）

- **左侧导航**：5 个模块竖排，每项含主题色图标、模块名、「N 项功能」、总开关（点击开关不触发选中，已 stopPropagation）；选中项高亮 + 左边框用模块主题色；`max-height` + `overflow-y: auto` 支持模块增多后滚动
- **右侧详情**：顶部模块图标/名称/描述 + 总开关（与左侧联动，同一状态源），顶部 3px 主题色条；子功能一行行排开；创作中心的两个子分组以子卡片呈现（分组开关关闭时子项 disabled 但保留原值）；面板独立滚动
- **响应式**：≤1024px 时上下堆叠并取消高度限制
- 容器：`grid-template-columns: 280px minmax(0, 1fr)`

> 注：中间迭代过「卡片网格 + 子功能折叠展开」版本，最终被主从布局取代。

## 交互细节

- **批量操作**：全开（全部置 true）；全关（`window.confirm` 二次确认，防止误操作导致桌面端全黑）；恢复默认 = 重新拉取当前作用域的权限行（DB 值）
- **未保存提示**：`values` 与加载/保存成功时的 `initialValues` 逐 key 对比，不一致时保存按钮旁显示橙色「有未保存更改」徽章（`.badge-warning`）
- **保存**：delete + insert 当前作用域全部真实 key；校验至少保留一个主 Tab；写审计日志；成功后同步 `initialValues` 并弹 toast（带 `CircleCheck` 图标）
- **快捷键**：Ctrl+S / Cmd+S 保存（`saveRef` 避免闭包过期）
- **禁用态**：子功能行用 `var(--color-muted)` 背景 + 灰文字，不再 opacity 一刀切；`.toggle` 增加 disabled 滑块样式
- 所有原生 `<input type="checkbox">` 均替换为项目已有 `.toggle` 组件

## CSS 变更（globals.css）

- 移除：旧 `.permission-layout` / `.permission-section*` / `.permission-check*` / `.permission-tab-*` 及中间版 `.permission-dashboard` / `.permission-card*`
- 新增：`.permission-workspace` / `.permission-module-nav` / `.permission-module-item` / `.permission-module-panel` / `.permission-panel-*` / `.permission-feature-row` / `.permission-subcard` / `.scope-select*` / `.permission-batch-actions` 等
- 补定义 `:root` 变量 `--color-muted-foreground: #64748B` 与 `--color-text-muted: #64748B`（此前被 `.text-muted` 等引用但从未定义）

## 兼容性说明

- 页面 import 路径 `@/components/desktop-permissions` 不变（目录 `index.ts` 导出）
- 落库 key 集合与重构前完全一致（21 个），桌面端 `useDesktopPermissions` / `CreationCenter` 无需改动
- lucide-react@1.31.0 无 `History` 图标，历史模块使用 `Clock`

## 验证

- `npx tsc --noEmit`（apps/admin）通过
- 旧 CSS 类全局搜索无残留引用
