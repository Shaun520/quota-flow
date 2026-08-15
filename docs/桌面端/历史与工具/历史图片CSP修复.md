# 历史记录详情参考图片不显示修复记录

> 修复日期：2026-08-13
> 修复范围：apps/desktop 渲染进程（CSP 配置）
> 关联设计：desktop-history-design.md、desktop-img2video-plan.md

---

## 一、问题描述

在「历史记录」查看某条生成视频的详情时，图生视频任务提供的参考图片（上传图片）**不显示**：
- 详情弹窗中的「上传图片」区域为空白，或仅显示占位/无图片。
- 点击放大浮层同样无法显示图片。

而同一页面里的**视频预览/缩略图是正常的**。

---

## 二、根因分析

图片回显的整条链路（副本落盘 → 持久化 → 读取映射 → URL 解析）本身都是正确的：

1. **副本落盘** `dispatch.ts`：生成时把用户图片复制到 `userData/images/<jobId>-<n>.<ext>`，副本绝对路径写入 `jobOptions.images`。
2. **持久化** `dispatch.ts`：成功/失败路径均通过 `{ ...jobOptions, ... }` 把 `images` 字段写入 jobs 表的 `options` JSONB。
3. **读取映射** `useJobs.ts`：`opts.images` → `record.images`。
4. **URL 解析** `History.tsx`：取文件 basename → `window.api.media.getImageUrl(name)`。
5. **URL 生成** `main/index.ts`：返回 `http://127.0.0.1:<随机端口>/images/<name>`，本地 HTTP 服务能正确命中并返回图片。

真正的问题出在**最后一步：渲染层 CSP 的 `img-src` 没有放行本地媒体服务**。

[index.html](../../../apps/desktop/src/renderer/index.html) 中的 CSP 原先为：

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
media-src 'self' https: blob: http://127.0.0.1:*;
connect-src 'self' https: ws://localhost:* http://localhost:*
```

对比两个关键指令：

| 指令 | 是否放行 `http://127.0.0.1:*` | 影响 |
|---|---|---|
| `media-src` | ✅ 放行 | `<video>` 能播放本地视频 → 视频预览/缩略图正常 |
| `img-src` | ❌ 仅 `'self' data: blob:` | `<img src="http://127.0.0.1:...">` 被 CSP 拦截 → 图片不显示 |

**结论**：
- 视频能看，是因为 `media-src` 放行了 `http://127.0.0.1:*`；且 `VideoThumb` 的缩略图是用 canvas `toDataURL` 生成的 `data:` URL，也在 `img-src` 白名单内。
- 参考图片看不到，是因为详情弹窗里的 `<img>` 用了 `http://127.0.0.1:<随机端口>/images/...`，而 `img-src` 不含 `http://127.0.0.1:*`，浏览器直接拒绝加载（点击放大浮层同理）。

---

## 三、修复方案

在 [index.html](../../../apps/desktop/src/renderer/index.html) 的 `img-src` 中补上 `http://127.0.0.1:*`，与 `media-src` 保持一致：

```html
<!-- Before -->
img-src 'self' data: blob:;

<!-- After -->
img-src 'self' data: blob: http://127.0.0.1:*;
```

修复后完整 CSP：

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: http://127.0.0.1:*;
media-src 'self' https: blob: http://127.0.0.1:*;
connect-src 'self' https: ws://localhost:* http://localhost:*
```

> 说明：媒体服务端口在启动时随机分配（`server.listen(0)`），因此必须用 `127.0.0.1:*` 通配端口，不能写死端口号。`127.0.0.1` 为回环地址、仅本机可达，放行其图片源风险很低，与既有 `media-src` 做法一致。

---

## 四、改动文件清单

| 文件 | 改动内容 |
|---|---|
| [index.html](../../../apps/desktop/src/renderer/index.html) | CSP `img-src` 增加 `http://127.0.0.1:*`，放行本地媒体服务的图片 |

---

## 五、验证步骤

1. 重新构建并启动桌面端（CSP 写在 `index.html`，需重新构建 renderer 静态资源）。
2. 使用「图生视频」模式上传参考图片并完成一次生成。
3. 进入「历史记录」，点击该任务的「查看详情」。
   - 「上传图片」区域应正常显示参考图片缩略图。
   - 点击图片可放大预览。
4. 确认视频预览/缩略图仍正常（回归验证，不受本次改动影响）。

---

## 六、关键结论

1. **CSP 指令按资源类型分别生效**：`<img>` 走 `img-src`，`<video>` 走 `media-src`，二者需分别放行。只放行 `media-src` 不能让 `<img>` 加载到本地媒体服务。
2. **本地随机端口媒体服务在 CSP 中必须用 `127.0.0.1:*` 通配**：端口是运行时随机分配的，写死端口号无效。
3. 排查「图片不显示、视频正常」这类现象时，优先核对 CSP 的 `img-src` / `media-src` 差异，而不是先怀疑数据落盘或回显逻辑。
