"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createAdminBrowserClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = searchParams.get("next") ?? "/dashboard";
  const errorParam = searchParams.get("error");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!isSupabaseConfigured()) {
      setError("Supabase 未配置。请先设置 NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY。");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createAdminBrowserClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password
      });
      if (signInError) {
        setError(signInError.message);
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("is_admin")
        .eq("id", data.user.id)
        .maybeSingle();

      if (profileError || !profile?.is_admin) {
        await supabase.auth.signOut();
        setError("该账号没有 admin 权限。请先在 profiles 表标记 is_admin=true。");
        return;
      }

      router.push(next);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败，请检查配置。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
      {errorParam === "not_admin" ? <div className="login-msg error">该账号不是管理员，已退出登录。</div> : null}
      {error ? <div className="login-msg error">{error}</div> : null}
      <div className="login-field">
        <label htmlFor="email">邮箱</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="admin@example.com"
          required
          autoComplete="email"
        />
      </div>
      <div className="login-field">
        <label htmlFor="password">密码</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="请输入密码"
          required
          autoComplete="current-password"
        />
      </div>
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? "登录中..." : "登录"}
      </button>
      <p className="login-hint">
        执行 0007_admin_tables.sql 后，需要手动把运营者账号在 profiles 表标记为 is_admin=true。
      </p>
    </form>
  );
}
