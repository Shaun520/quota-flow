import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

export function createAdminBrowserClient() {
  const { url, anonKey } = supabaseEnv();
  if (!url || !anonKey) {
    throw new Error("Supabase 环境变量未配置：NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  return createBrowserClient(url, anonKey);
}
