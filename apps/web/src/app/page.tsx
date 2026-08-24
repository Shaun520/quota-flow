import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  Zap,
  Download,
  Github,
  Clock,
  Sparkles,
  Users,
  Monitor,
  ShieldCheck,
  UserPlus,
  Cookie,
  Wrench,
  LayoutGrid,
  Database,
  ArrowRight,
  Check
} from "lucide-react";

export const metadata: Metadata = {
  title: "Quota-Flow — 让 9 家 AI 视频厂商的免费额度，为你所用",
  description: "Quota-Flow 是一站式 AI 视频免费额度调度平台。自动归集、智能路由、团队共享，告别反复登录与额度沉睡。"
};

const LOGO_BASE = "https://raw.githubusercontent.com/shixian2316/qf-images-host/main/provider-logos/";

const vendors = [
  { name: "豆包", unit: "点", logo: `${LOGO_BASE}doubao.png` },
  { name: "通义万相", unit: "额度", logo: `${LOGO_BASE}qwenwan.png` },
  { name: "千问（通义万相）", unit: "额度", logo: `${LOGO_BASE}qwenwan.png` },
  { name: "元宝混元", unit: "个", logo: `${LOGO_BASE}yuanbao.png` },
  { name: "Dola", unit: "点", logo: `${LOGO_BASE}dola.png` },
  { name: "智谱", unit: "次 / 免费", logo: `${LOGO_BASE}zhipu.png` },
  { name: "火山方舟", unit: "免费额度", logo: `${LOGO_BASE}volcengine.png` },
  { name: "阿里云百炼", unit: "Key 额度", logo: `${LOGO_BASE}bailian.png` },
  { name: "腾讯云TokenHub", unit: "积分", logo: `${LOGO_BASE}tokenhub.png` }
];

const painPoints = [
  {
    icon: Clock,
    title: "账号切换的繁琐",
    desc: "扫码、验证、切账号……生成一条视频，往往十分钟耗在登录与跳转上，创意被打断。"
  },
  {
    icon: Sparkles,
    title: "额度沉睡的浪费",
    desc: "这家还剩 3 次，那家早已用完。免费额度像碎片，凑不出一次完整的创作。"
  },
  {
    icon: Users,
    title: "团队各自为战",
    desc: "每人重复绑定同一厂商，额度不能叠加，协作成本居高不下，免费优势无从放大。"
  }
];

const features = [
  {
    icon: Monitor,
    title: "动态额度账本",
    desc: "按次数、灵感值、积分等原生单位实时记账；按时长、分辨率、模型动态扣减，每日自动刷新。"
  },
  {
    icon: ShieldCheck,
    title: "智能调度 + 预检查",
    desc: "提交前预估算本次消耗，自动跳过余额不足账号，为每一次创作挑选最划算的厂商。"
  },
  {
    icon: UserPlus,
    title: "多账号池化",
    desc: "同一厂商绑定多个账号，额度自动叠加；单账号失效时无缝 failover，创作不中断。"
  },
  {
    icon: Users,
    title: "团队共享池",
    desc: "多人多账号额度汇入团队池，统一配额与审计。小团队也能把免费创作力放大数倍。"
  },
  {
    icon: Cookie,
    title: "Cookie 自动续命",
    desc: "隔离会话 + 实例池共享，凌晨静默续期。平均 1–2 个月才需重新登录一次，省心省力。"
  },
  {
    icon: Wrench,
    title: "快速接入新厂商",
    desc: "声明式配置页面地址与 DOM 选择器，无需逆向 bx-ua 等风控签名，新厂商约 2 小时即可上线。"
  }
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="container">
          <div className="hero-grid">
            <div className="hero-content">
              <div className="eyebrow">
                <Zap size={14} />
                AI 视频免费额度调度平台
              </div>
              <h1>
                让 9 家 AI 视频厂商的<br />
                <span className="accent-text">免费额度，为你所用</span>
              </h1>
              <p className="hero-desc">
                豆包、通义万相、千问（通义万相）、元宝混元、Dola、智谱、火山方舟、阿里云百炼、腾讯云TokenHub —— 多家账号额度自动归集、智能路由、团队共享。告别反复登录与额度沉睡，把每一份免费创作力用到极致。
              </p>
              <div className="hero-actions">
                <Link href="/download" className="btn btn-primary btn-lg">
                  <Download size={18} />
                  下载 Windows 版
                </Link>
                <a
                  href="https://github.com/Shaun520/quota-flow"
                  className="btn btn-secondary btn-lg"
                  target="_blank"
                  rel="noreferrer"
                >
                  <Github size={18} />
                  GitHub
                </a>
              </div>
              <div className="hero-stats">
                <div>
                  <div className="stat-value">9</div>
                  <div className="stat-label">接入厂商</div>
                </div>
                <div>
                  <div className="stat-value">∞</div>
                  <div className="stat-label">账号叠加</div>
                </div>
                <div>
                  <div className="stat-value">≈2h</div>
                  <div className="stat-label">接入新厂商</div>
                </div>
              </div>
            </div>

            <div className="dashboard-mockup dark-app" aria-hidden="true">
              <Image
                src="/images/hero-screenshot.png"
                alt="Quota-Flow 桌面端调度台界面"
                width={1200}
                height={800}
                className="mockup-screenshot"
                priority
              />
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="pain">
        <div className="container">
          <div className="section-title">
            <h2>别让免费额度，散落在九个账号里</h2>
            <p>每家厂商独立登录、独立刷新、独立额度单位。个人难以记清，团队无法复用。Quota-Flow 把零散额度汇成一本清晰的账。</p>
          </div>
          <div className="pain-grid">
            {painPoints.map((item) => (
              <div className="pain-card" key={item.title}>
                <div className="icon-wrap">
                  <item.icon size={22} />
                </div>
                <h3>{item.title}</h3>
                <p>{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section vendors-section" id="vendors">
        <div className="container">
          <div className="section-title">
            <h2>9 家主流厂商，一站接入</h2>
            <p>按各平台原生单位自动记账，实时同步额度与状态。WebView 统一引擎接入，无需破解风控签名。</p>
          </div>
          <div className="vendor-grid">
            {vendors.map((v) => (
              <div className="vendor-cell" key={v.name}>
                <div className="vendor-logo">
                  <img src={v.logo} alt={v.name} loading="lazy" />
                </div>
                <h4>{v.name}</h4>
                <span>{v.unit}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="features">
        <div className="container">
          <div className="section-title">
            <h2>核心特性</h2>
            <p>从额度归集到智能调度，从多账号池化到团队共享，让每一份免费额度都物尽其用。</p>
          </div>
          <div className="feature-grid">
            {features.map((f) => (
              <div className="feature-card" key={f.title}>
                <div className="icon-wrap">
                  <f.icon size={20} />
                </div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section how-section" id="how">
        <div className="container">
          <div className="section-title">
            <h2>三步开始调度</h2>
            <p>桌面端是创作入口，WebView 引擎在后台完成厂商调用，Supabase 负责账本与团队协作。</p>
          </div>
          <div className="how-grid">
            <div className="how-step">
              <div className="step-num">1</div>
              <h3>绑定账号</h3>
              <p>在桌面端授权登录各厂商，额度自动归集到统一账本，Cookie 本地安全保存。</p>
            </div>
            <div className="how-step">
              <div className="step-num">2</div>
              <h3>一键生成</h3>
              <p>输入创意与参数，系统自动预估消耗、选择厂商、提交任务；失败时无缝切换次优方案。</p>
            </div>
            <div className="how-step">
              <div className="step-num">3</div>
              <h3>额度共享</h3>
              <p>个人账号本地解密自用，团队账号由 Edge Function 代调用，密钥始终留在云端之外。</p>
            </div>
          </div>
          <div className="architecture-card">
            <div className="arch-flow">
              <div className="arch-node">
                <div className="node-icon">
                  <Monitor size={32} strokeWidth={1.5} />
                </div>
                <h4>桌面端 Electron</h4>
                <p>React 交互界面 + 本地调度引擎，创作唯一入口</p>
              </div>
              <div className="arch-arrow">
                <ArrowRight size={28} />
              </div>
              <div className="arch-node">
                <div className="node-icon">
                  <LayoutGrid size={32} strokeWidth={1.5} />
                </div>
                <h4>WebView 统一引擎</h4>
                <p>Cookie 注入、自动提交、实例池共享与续期</p>
              </div>
              <div className="arch-arrow">
                <ArrowRight size={28} />
              </div>
              <div className="arch-node">
                <div className="node-icon">
                  <Database size={32} strokeWidth={1.5} />
                </div>
                <h4>Supabase 账本</h4>
                <p>Postgres 账本、Auth、Edge Functions 与 Realtime</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="pricing">
        <div className="container">
          <div className="section-title">
            <h2>开源免费，人人可用</h2>
            <p>个人、团队、自部署，全部功能永久免费。没有付费墙，没有席位上限，只有社区共同维护。</p>
          </div>
          <div className="pricing-grid">
            <div className="pricing-card">
              <h3>个人用户</h3>
              <div className="price">免费</div>
              <div className="seat">本地使用，数据不离本机</div>
              <ul>
                <li><Check size={16} strokeWidth={3} />完整核心功能</li>
                <li><Check size={16} strokeWidth={3} />9 家厂商接入</li>
                <li><Check size={16} strokeWidth={3} />无限账号池化</li>
              </ul>
              <Link href="/download" className="btn btn-secondary">免费下载</Link>
            </div>
            <div className="pricing-card featured">
              <div className="pricing-badge">推荐</div>
              <h3>团队用户</h3>
              <div className="price">免费</div>
              <div className="seat">共享额度池，无席位上限</div>
              <ul>
                <li><Check size={16} strokeWidth={3} />完整核心功能</li>
                <li><Check size={16} strokeWidth={3} />团队共享额度池</li>
                <li><Check size={16} strokeWidth={3} />成员与权限管理</li>
              </ul>
              <Link href="/download" className="btn btn-primary">免费下载</Link>
            </div>
            <div className="pricing-card">
              <h3>自部署</h3>
              <div className="price">免费</div>
              <div className="seat">数据自主，完全掌控</div>
              <ul>
                <li><Check size={16} strokeWidth={3} />全部功能开放</li>
                <li><Check size={16} strokeWidth={3} />无用户数限制</li>
                <li><Check size={16} strokeWidth={3} />运营方不可见数据</li>
              </ul>
              <Link href="/docs#self-host" className="btn btn-secondary">查看自部署指南</Link>
            </div>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="cta-banner">
            <h2>让每一次免费额度，都物尽其用</h2>
            <p>个人永久免费，小团队零成本起步。下载桌面端，几分钟即可绑定第一家厂商。</p>
            <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
              <a
                href="https://github.com/Shaun520/quota-flow/releases"
                className="btn btn-lg btn-secondary"
                target="_blank"
                rel="noreferrer"
              >
                下载 Windows 版
              </a>
              <a
                href="https://github.com/Shaun520/quota-flow"
                className="btn btn-lg btn-outline-white"
                target="_blank"
                rel="noreferrer"
              >
                在 GitHub 上查看
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
