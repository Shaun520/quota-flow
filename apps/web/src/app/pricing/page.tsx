import type { Metadata } from "next";
import Link from "next/link";
import {
  Layers,
  ShieldCheck,
  Users,
  User,
  Server,
  Check,
  Github,
  FileText
} from "lucide-react";

export const metadata: Metadata = {
  title: "开源免费 — Quota-Flow",
  description: "Quota-Flow 是公益性质的开源项目。所有功能对个人和团队永久免费，自部署用户更可无限制使用。"
};

const plans = [
  {
    icon: User,
    title: "个人用户",
    price: "免费",
    desc: "本地使用，数据不离本机",
    features: ["完整核心功能", "9 家厂商接入", "无限账号池化", "社区支持"],
    cta: { text: "免费下载", href: "/download", primary: false }
  },
  {
    icon: Users,
    title: "团队用户",
    price: "免费",
    desc: "共享额度池，多人协作",
    features: ["完整核心功能", "团队共享额度池", "成员与权限管理", "无席位上限"],
    cta: { text: "免费下载", href: "/download", primary: true },
    featured: true
  },
  {
    icon: Server,
    title: "自部署",
    price: "免费",
    desc: "数据自主，完全掌控",
    features: ["全部功能开放", "无用户数限制", "运营方不可见数据", "完整源码可修改"],
    cta: { text: "查看自部署指南", href: "/docs#self-host", primary: false }
  }
];

const opensourcePoints = [
  "不收集用户 Cookie 或额度数据（自部署模式下运营方完全不可见）",
  "MIT 协议，可自由使用、修改、二次分发",
  "欢迎贡献代码、文档、厂商适配或问题反馈"
];

const sponsors = [
  {
    title: "GitHub Sponsors",
    amount: "$0+",
    unit: "/月",
    desc: "通过 GitHub 官方渠道进行一次性或周期性赞助，资金透明可查。",
    cta: "前往赞助",
    href: "https://github.com/sponsors/Shaun520"
  },
  {
    title: "贡献代码",
    amount: "免费",
    unit: "",
    desc: "提交 PR、修复 bug、撰写文档、适配新厂商，都是最有价值的支持。",
    cta: "查看贡献指南",
    href: "https://github.com/Shaun520/quota-flow/blob/main/CONTRIBUTING.md"
  },
  {
    title: "分享给朋友",
    amount: "免费",
    unit: "",
    desc: "把 Quota-Flow 推荐给需要的朋友，让更多人用得更顺手。",
    cta: "复制项目链接",
    href: "https://github.com/Shaun520/quota-flow"
  }
];

const faqs = [
  { q: "使用 Quota-Flow 真的完全免费吗？", a: "是的。无论是个人使用、团队协作还是自部署，所有核心功能均永久免费，没有隐藏收费，也没有额度抽成。" },
  { q: "自部署需要服务器费用吗？", a: "自部署需要你自己准备 Supabase 或兼容后端，但 Quota-Flow 本身不收取任何费用。你也可以完全离线使用个人模式。" },
  { q: "团队人数有上限吗？", a: "没有。免费团队版同样支持 unlimited 成员，功能与自部署完全一致。若团队规模很大，建议自部署以获得更好的数据掌控。" },
  { q: "以后会收费吗？", a: "核心功能将始终保持免费。未来若提供官方托管等增值服务，也会保留完整的免费自部署路径，不会把已有功能变为付费。" },
  { q: "商业化使用是否允许？", a: "允许。MIT 协议允许你在商业环境中自由使用、修改和分发，只需保留原始版权声明。" },
  { q: "如何获得支持？", a: "优先通过 GitHub Issues 提交问题，社区会共同响应。你也可以发送邮件至 support@quota-flow.com。" }
];

export default function PricingPage() {
  return (
    <>
      <section className="page-hero">
        <div className="container">
          <h1>完全免费，开源共享</h1>
          <p>Quota-Flow 是一个公益性质的开源项目。所有功能对个人和团队永久免费，自部署用户更可无限制使用。</p>
          <div className="hero-badges">
            <span className="hero-badge"><Layers size={14} />MIT 协议开源</span>
            <span className="hero-badge"><ShieldCheck size={14} />无功能限制</span>
            <span className="hero-badge"><Users size={14} />无席位上限</span>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="pricing-grid cols-3">
            {plans.map((plan) => (
              <div className={`pricing-card${plan.featured ? " featured" : ""}`} key={plan.title}>
                {plan.featured && <div className="pricing-badge">推荐</div>}
                <div className="pricing-icon">
                  <plan.icon size={28} />
                </div>
                <h3>{plan.title}</h3>
                <div className="price">{plan.price}</div>
                <div className="desc">{plan.desc}</div>
                <ul>
                  {plan.features.map((f) => (
                    <li key={f}><Check size={16} strokeWidth={3} />{f}</li>
                  ))}
                </ul>
                <Link href={plan.cta.href} className={`btn${plan.cta.primary ? " btn-primary" : " btn-secondary"}`}>
                  {plan.cta.text}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="opensource-section">
        <div className="container">
          <div className="opensource-grid">
            <div className="opensource-content">
              <h2>为什么免费？</h2>
              <p>Quota-Flow 起源于一个朴素的观察：AI 视频厂商每天都在赠送免费额度，但用户却被困在反复登录和额度分散的麻烦里。</p>
              <p>我们相信，把「薅免费额度」这件事做得更优雅，应该是每个人都能享有的工具，而不是付费墙后的特权。因此项目选择完全开源，由社区共同维护。</p>
              <ul className="opensource-list">
                {opensourcePoints.map((text) => (
                  <li key={text}><ShieldCheck size={18} />{text}</li>
                ))}
              </ul>
            </div>
            <div className="opensource-card">
              <span className="license-tag">
                <FileText size={14} />
                MIT License
              </span>
              <h3>代码完全开放</h3>
              <p>前端、桌面端、服务端逻辑全部托管在 GitHub。你可以审计每一行代码，也可以 fork 后按自己的需求定制。</p>
              <a
                href="https://github.com/Shaun520/quota-flow"
                className="btn btn-primary btn-lg"
                target="_blank"
                rel="noreferrer"
              >
                <Github size={18} />
                访问 GitHub 仓库
              </a>
              <div className="github-stats">
                <div className="github-stat"><div className="num">—</div><div className="label">Stars</div></div>
                <div className="github-stat"><div className="num">—</div><div className="label">Forks</div></div>
                <div className="github-stat"><div className="num">—</div><div className="label">Contributors</div></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="sponsor-section">
        <div className="container">
          <div className="section-title">
            <h2>支持项目持续运行</h2>
            <p>如果你认可这个项目，可以通过赞助帮助维护者投入更多时间。所有赞助完全自愿，不影响任何功能使用。</p>
          </div>
          <div className="sponsor-grid">
            {sponsors.map((s) => (
              <div className="sponsor-card" key={s.title}>
                <h3>{s.title}</h3>
                <div className="amount">{s.amount}<span>{s.unit}</span></div>
                <p>{s.desc}</p>
                <a href={s.href} className="btn btn-secondary" target="_blank" rel="noreferrer">{s.cta}</a>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="faq-section">
        <div className="container">
          <div className="section-title">
            <h2>常见问题</h2>
            <p>关于免费策略、开源协议与支持的说明。</p>
          </div>
          <div className="faq-grid">
            {faqs.map((item) => (
              <div className="faq-card" key={item.q}>
                <h3>{item.q}</h3>
                <p>{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0, paddingBottom: 80 }}>
        <div className="container">
          <div className="cta-banner">
            <h2>开始使用，无需付费</h2>
            <p>下载桌面端，几分钟内即可绑定第一家厂商，把散落的免费额度聚成一个池子。</p>
            <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
              <Link href="/download" className="btn btn-lg btn-secondary">免费下载</Link>
              <a
                href="https://github.com/Shaun520/quota-flow"
                className="btn btn-lg btn-outline-white"
                target="_blank"
                rel="noreferrer"
              >
                <Github size={18} />
                Star on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
