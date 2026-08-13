import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
  title: "登录 · Quota-Flow Admin"
};

export default function LoginPage() {
  return (
    <main className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">QF</span>
          <span>Quota-Flow Admin</span>
        </div>
        <h1 className="login-title">管理员登录</h1>
        <p className="login-subtitle">使用已开通 is_admin 的 Supabase 账号登录后台。</p>
        <Suspense fallback={<div className="login-msg">正在加载登录页...</div>}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
