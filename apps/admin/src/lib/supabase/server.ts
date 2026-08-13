import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseEnv } from "./env";

export async function createAdminServerClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = supabaseEnv();
  if (!url || !anonKey) {
    throw new Error("Supabase 环境变量未配置：NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Component 中无法写 cookie 时忽略，middleware 已负责写入。
        }
      }
    }
  });
}
