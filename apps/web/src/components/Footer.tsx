import Link from "next/link";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <Link href="/" className="brand">
              <span className="brand-mark">Q</span>
              Quota-Flow
            </Link>
            <p>一站式 AI 视频额度调度平台。将多家厂商的每日免费额度汇聚一处，让个人创作更从容，让团队协作更高效。</p>
          </div>
          <div className="footer-col">
            <h4>产品</h4>
            <ul>
              <li><Link href="/download">下载</Link></li>
              <li><Link href="/pricing">开源免费</Link></li>
              <li><Link href="/#features">特性</Link></li>
              <li><Link href="/">路线图</Link></li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>开发者</h4>
            <ul>
              <li><a href="https://github.com/Shaun520/quota-flow" target="_blank" rel="noreferrer">GitHub</a></li>
              <li><Link href="/docs#quickstart">快速开始</Link></li>
              <li><Link href="/docs#self-host">自部署指南</Link></li>
              <li><Link href="/">API 文档</Link></li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>支持</h4>
            <ul>
              <li><a href="https://github.com/Shaun520/quota-flow/issues" target="_blank" rel="noreferrer">问题反馈</a></li>
              <li><a href="mailto:support@quota-flow.com">support@quota-flow.com</a></li>
              <li><Link href="/">合规声明</Link></li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2026 Quota-Flow. Open source under MIT.</span>
          <span>完全免费，开源共享。</span>
        </div>
      </div>
    </footer>
  );
}
