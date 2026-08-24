"use client";

import Link from "next/link";
import { Github } from "lucide-react";

export default function RegisterClient() {
  return (
    <main className="register-main">
      <div className="register-card">
        <h1>创建账号</h1>
        <p className="register-subtitle">注册后即可在桌面端登录，开始调度你的免费额度。</p>

        <a
          href="https://github.com/Shaun520/quota-flow"
          className="github-btn"
          target="_blank"
          rel="noreferrer"
        >
          <Github size={20} />
          通过 GitHub 注册
        </a>

        <div className="divider">或</div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            alert("MVP 阶段仅开放 GitHub 注册");
          }}
        >
          <div className="form-group">
            <label htmlFor="email">邮箱</label>
            <input type="email" id="email" placeholder="you@example.com" required />
          </div>
          <div className="form-group">
            <label htmlFor="password">密码</label>
            <input type="password" id="password" placeholder="至少 8 位字符" required />
          </div>
          <div className="form-group">
            <label htmlFor="confirm">确认密码</label>
            <input type="password" id="confirm" placeholder="再次输入密码" required />
          </div>
          <div className="checkbox-row">
            <input type="checkbox" id="terms" required />
            <label htmlFor="terms">
              我已阅读并同意 <Link href="#">服务条款</Link> 与 <Link href="#">隐私政策</Link>
            </label>
          </div>
          <button type="submit" className="btn btn-primary btn-lg btn-full">
            创建账号
          </button>
        </form>

        <p className="register-footer">
          已有账号？<Link href="#">直接登录</Link>
        </p>

        <div className="mvp-note">
          MVP 阶段优先通过 GitHub 入口注册，邮箱注册将在后续版本接入 Supabase Auth 后开放。
        </div>
      </div>
    </main>
  );
}
