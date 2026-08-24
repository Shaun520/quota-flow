"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Info,
  AlertTriangle,
  CheckCircle,
  ChevronDown
} from "lucide-react";

const sidebarGuideLinks = [
  { id: "quickstart", label: "快速开始" },
  { id: "self-host", label: "自部署教程" },
  { id: "providers", label: "厂商清单" },
  { id: "faq", label: "常见问题" }
];

const sidebarRefLinks = [
  { href: "https://github.com/Shaun520/quota-flow", label: "GitHub 仓库" },
  { href: "https://github.com/Shaun520/quota-flow/releases", label: "版本发布" },
  { href: "https://github.com/Shaun520/quota-flow/issues", label: "问题反馈" }
];

const installCommands = `# Windows
Quota-Flow Setup x.y.z.exe

# macOS
open Quota-Flow-x.y.z.dmg

# Linux (AppImage)
chmod +x Quota-Flow-x.y.z.AppImage
./Quota-Flow-x.y.z.AppImage`;

const cloneCommands = `git clone https://github.com/Shaun520/quota-flow.git
cd quota-flow
pnpm install
pnpm build`;

const envCommands = `cp .env.example .env
# 编辑 .env，填入：
# SUPABASE_URL=https://your-project.supabase.co
# SUPABASE_ANON_KEY=your-anon-key
# SELF_HOSTED=true`;

const startCommands = `cd apps/desktop
pnpm dev`;

const cliCommands = `# 查看额度总览
pnpm --filter @quota-flow/cli dev check-quota

# 指定厂商生成
pnpm --filter @quota-flow/cli dev generate --mode text2video \\
  --prompt "生成5秒猫咪视频" --provider yuanbao --json

# 不指定厂商，走智能调度
pnpm --filter @quota-flow/cli dev generate --mode text2video \\
  --prompt "生成5秒猫咪视频" --json

# 刷新账本
pnpm --filter @quota-flow/cli dev refresh`;

const providerRows = [
  ["豆包", "doubao.com", "点", "时长（5s/10s）", "WebView cookie 注入"],
  ["通义万相", "tongyi.aliyun.com", "额度", "时长", "WebView cookie 注入"],
  ["千问（通义万相）", "tongyi.aliyun.com", "额度", "时长", "WebView cookie 注入"],
  ["元宝混元", "yuanbao.tencent.com", "个", "固定次数", "WebView cookie 注入"],
  ["Dola", "www.dola.com", "点", "固定次数", "WebView cookie 注入"],
  ["智谱", "open.bigmodel.cn", "次 / 免费", "时长 + 分辨率 + 模型", "API Key 注入"],
  ["火山方舟", "volcengine.com", "免费额度", "时长 + 模型", "API Key 注入"],
  ["阿里云百炼", "bailian.aliyun.com", "Key 额度", "时长 + 模型", "API Key 注入"],
  ["腾讯云TokenHub", "cloud.tencent.com", "积分", "时长 + 分辨率 + 模型", "API Key 注入"]
];

const docsFaqs = [
  {
    q: "Quota-Flow 是 SaaS 吗？",
    a: "不是传统 SaaS。Quota-Flow 是开源桌面端工具，官方提供托管的数据库与团队协作功能。你也可以完全自部署，脱离官方托管。"
  },
  {
    q: "我的 cookie 会被上传到云端吗？",
    a: "个人自绑的 cookie 只在本地内存解密，不会上传。团队公共 cookie 会加密后存到 Supabase，成员通过 Edge Function 代调用，明文不出云端。"
  },
  {
    q: "为什么用 WebView 而不是直接调 API？",
    a: "国内主流厂商的免费额度绑登录态，公开 API 是付费按量的。WebView 方案直接复用厂商官方页面，自带风控签名，无需逆向，接入新厂商只需填选择器。"
  },
  {
    q: "团队额度池是怎么计算的？",
    a: "团队总池 = admin 绑定的公共额度 + 成员自愿贡献的自带额度。不同厂商的原生单位按消耗表折算成「等效次数」用于总览 UI，实际扣减仍按各厂商原生单位执行。"
  },
  {
    q: "cookie 多久会过期？",
    a: "不同厂商寿命不同，一般为 7-30 天。系统每天凌晨 3 点后台静默访问厂商首页自动续命，目标是将重新登录频率降到平均 1-2 个月一次。"
  },
  {
    q: "个人免费版有什么限制？",
    a: "个人免费版包含全部核心功能与 9 家厂商接入，唯一区别是不能创建团队共享池，仅限 1 人使用。"
  }
];

export default function DocsClient() {
  const [openFaq, setOpenFaq] = useState<number>(0);
  const [activeId, setActiveId] = useState<string>("quickstart");

  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>(".docs-section");
    const handleScroll = () => {
      let current = "";
      sections.forEach((section) => {
        const top = section.getBoundingClientRect().top;
        if (top <= 120) {
          current = section.id;
        }
      });
      if (current) setActiveId(current);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <>
      <section className="page-hero">
        <div className="container">
          <h1>文档</h1>
          <p>从下载安装到自部署，从厂商接入到团队共享，这里有你需要的全部指南。</p>
        </div>
      </section>

      <div className="container">
        <div className="docs-layout">
          <aside className="docs-sidebar">
            <div className="sidebar-section">
              <div className="sidebar-title">指南</div>
              <ul className="sidebar-links">
                {sidebarGuideLinks.map((link) => (
                  <li key={link.id}>
                    <a href={`#${link.id}`} className={activeId === link.id ? "active" : ""}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="sidebar-section">
              <div className="sidebar-title">参考</div>
              <ul className="sidebar-links">
                {sidebarRefLinks.map((link) => (
                  <li key={link.href}>
                    <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          <main className="docs-main">
            <section className="docs-section" id="quickstart">
              <h2>快速开始</h2>
              <p>Quota-Flow 是一款桌面端工具，所有功能都在桌面端完成。落地页只做介绍，不承载产品功能。</p>

              <h3>1. 下载安装</h3>
              <p>访问 <Link href="/download">下载页</Link>，根据系统自动获取对应安装包。目前支持 Windows、macOS 与 Linux。</p>
              <pre><code>{installCommands}</code></pre>

              <h3>2. 选择使用模式</h3>
              <p>首次启动会提示选择模式：</p>
              <ul>
                <li><strong>官方托管（推荐）</strong>：注册账号即可使用，团队无席位上限，适合绝大多数用户。</li>
                <li><strong>自部署</strong>：数据完全由自己掌控，无席位限制，适合技术用户或隐私敏感场景。</li>
              </ul>

              <div className="callout info">
                <div className="callout-icon"><Info size={18} /></div>
                <p>自部署用户需要自备 Supabase 项目，并手动执行 migrations。详见下方「自部署教程」。</p>
              </div>

              <h3>3. 绑定厂商账号</h3>
              <p>进入桌面端「设置」Tab，点击「绑定厂商」，按引导登录各家平台。登录完成后，cookie 会自动加密存储，额度会同步到账本。</p>
              <ul>
                <li>个人账号：本地内存解密，不上传云端。</li>
                <li>团队公共账号：加密上传 Supabase，成员通过 Edge Function 代调用，明文不出云端。</li>
              </ul>

              <h3>4. 生成第一个视频</h3>
              <p>切换到「调度台」Tab，输入 prompt 并选择时长/分辨率，点击「生成」。系统会自动：</p>
              <ol>
                <li>估算本次消耗</li>
                <li>选择可用额度最多的厂商账号</li>
                <li>后台提交生成请求</li>
                <li>返回视频 URL 并写入历史</li>
              </ol>

              <div className="callout success">
                <div className="callout-icon"><CheckCircle size={18} /></div>
                <p>首次生成建议在 prompt 中指定「5 秒、720p」，这是大多数厂商免费额度支持的基础配置。</p>
              </div>
            </section>

            <section className="docs-section" id="self-host">
              <h2>自部署教程</h2>
              <p>自部署适合希望完全掌控数据的技术用户。你需要自己注册 Supabase 并维护 migrations。</p>

              <h3>前置要求</h3>
              <ul>
                <li>Node.js ≥ 20</li>
                <li>pnpm 9.7.0+</li>
                <li>一个空的 Supabase 项目（已启用 Auth + Postgres）</li>
                <li>Git</li>
              </ul>

              <h3>安装步骤</h3>
              <ol className="steps-list">
                <li>
                  <strong>克隆仓库并安装依赖</strong>
                  <pre><code>{cloneCommands}</code></pre>
                </li>
                <li>
                  <strong>配置环境变量</strong>
                  <pre><code>{envCommands}</code></pre>
                </li>
                <li>
                  <strong>执行数据库迁移</strong>
                  <p>按序执行 <code>migrations/*.sql</code> 中的脚本。方式 A：在 Supabase Dashboard 的 SQL Editor 中逐个执行；方式 B：等待桌面端首次启动时提示自动执行。</p>
                </li>
                <li>
                  <strong>启动桌面端</strong>
                  <pre><code>{startCommands}</code></pre>
                  <p>首次启动时，在设置中填入 Supabase URL 与 anon key，然后注册或登录即可。</p>
                </li>
              </ol>

              <h3>CLI 真跑示例</h3>
              <p>自部署用户也可通过 CLI 验证调度与额度：</p>
              <pre><code>{cliCommands}</code></pre>

              <div className="callout warning">
                <div className="callout-icon"><AlertTriangle size={18} /></div>
                <p>自部署用户不享受官方客服支持。遇到问题可在 GitHub Issues 提出，但不承诺 SLA。</p>
              </div>
            </section>

            <section className="docs-section" id="providers">
              <h2>厂商清单</h2>
              <p>Quota-Flow 目前接入 9 家 AI 视频生成厂商。豆包/通义万相/千问/元宝/Dola 等走 WebView cookie，智谱/火山方舟/阿里云百炼/腾讯云TokenHub 走 API Key，统一由执行引擎调用。</p>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>厂商</th>
                      <th>产品</th>
                      <th>额度单位</th>
                      <th>影响因素</th>
                      <th>调用方式</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providerRows.map((row) => (
                      <tr key={row[0]}>
                        <td><strong>{row[0]}</strong></td>
                        <td>{row[1]}</td>
                        <td>{row[2]}</td>
                        <td>{row[3]}</td>
                        <td>{row[4]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3>关于扣减单位</h3>
              <p>不同厂商的免费额度单位不同：豆包/Dola 按「点」，元宝按「个」，TokenHub 按「积分」，通义万相按「额度」。系统通过 <code>provider_cost_tables</code> 维护各家消耗规则，最终折算成统一的「等效次数」用于总览展示。</p>
              <p>例如：只有完整账号额度归集后，不同厂商的原生单位折算成统一展示口径，用户无需记忆各家差异。</p>

              <h3>接入新厂商</h3>
              <p>得益于 WebView 统一执行引擎，新增一家 cookie 厂商通常只需填写一份 <code>WebProviderConfig</code>：</p>
              <ul>
                <li>登录页 URL 与生成页 URL</li>
                <li>prompt 输入框与发送按钮选择器</li>
                <li>结果提取方式（拦截响应 / 读取 DOM / 执行页面 JS）</li>
                <li>cookie 健康检查接口</li>
              </ul>
              <p>无需逆向各家风控签名，平均 2 小时即可完成接入。</p>
            </section>

            <section className="docs-section" id="faq">
              <h2>常见问题</h2>
              {docsFaqs.map((item, idx) => (
                <div className={`docs-faq-item${openFaq === idx ? " open" : ""}`} key={idx}>
                  <button
                    className="docs-faq-question"
                    onClick={() => setOpenFaq(openFaq === idx ? -1 : idx)}
                    aria-expanded={openFaq === idx}
                  >
                    {item.q}
                    <ChevronDown size={16} className="docs-faq-icon" />
                  </button>
                  <div className="docs-faq-answer">
                    <p>{item.a}</p>
                  </div>
                </div>
              ))}
            </section>
          </main>
        </div>
      </div>
    </>
  );
}
