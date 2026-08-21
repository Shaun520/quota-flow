# Quota-Flow AI 编码指令

> 这是仓库级 AI 编码入口。使用 AI 写代码前，必须阅读本文档以及详细开发规范。

## 强制阅读

在任何 AI 编码任务开始前，先读：

- `docs/开发规范/PostgREST数据与AI开发规范.md`

如果任务只改文档，也先读；如果任务改代码，尤其是 Supabase/PostgREST、列表页、历史、厂商账号、Admin 管理端相关代码，必须严格按规范执行。

## 核心门禁

1. Supabase/PostgREST 查询禁止默认 `select('*')` 或 `select()`；一律显式列出需要字段。
2. 默认不下发大字段和密钥：`encrypted_key`、`options`、`attempts`、`cost_breakdown` 等只在需要时才取。
3. 所有列表查询必须带分页/limit/range，前端列表必须服务端分页、搜索、筛选；不能无限制全量拉取。
4. 客户端禁止高频全量轮询；实时场景优先 Realtime，或按 `updated_at > lastSync` 增量拉取。
5. Admin 端不要把团队/用户等下拉做成 `pageSize: 1000` 全量加载，改用轻量 option 查询或搜索。

## Skill 触发规则

项目 skill 统一放在根目录 `skills/<skill-name>/`。满足下列任一条件时，自动加载对应 skill 并按其中方法执行；未命中则不加载。执行与主题相关的多 skill 时可叠加使用。

| 触发条件 | Skill |
|---------|-------|
| 编写/审查/重构任何代码，需规避常见 LLM 编码错误（过度设计、非外科手术式改动、隐藏假设） | `skills/karpathy-guidelines` |
| 接入第三方、处理外部系统数据，或要把「由外部决定的、会随时间变化的数值」写进代码前，必须先实测再写入 | `skills/measure-before-hardcode` |
| 反馈 PostgREST/Auth Egress 超额、请求数(SBUs)过高、流量异常上涨；新增/改动 Supabase/PostgREST 查询、列表页、账号/历史/额度数据访问；查询慢/超时需排查高频读 | `skills/postgrest-egress-optimization` |
| 涉及界面布局、交互、视觉呈现、UX 细节、组件样式等的设计或改动 | `skills/ui-ux-pro-max` |

## 冲突规则

- 用户在当前对话中显式覆盖时，以用户要求为准。
- 否则，本文档和 `docs/开发规范/PostgREST数据与AI开发规范.md` 优先于临时编码习惯、旧示例代码或历史文档中的反例。
