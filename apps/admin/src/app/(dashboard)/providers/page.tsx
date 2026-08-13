import { ProviderManager, type ProviderRow } from "@/components/provider-manager";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createAdminServerClient } from "@/lib/supabase/server";

export default async function ProvidersPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="page active">
        <div className="page-header">
          <div>
            <h1 className="page-title">Provider 管理</h1>
            <p className="page-subtitle">请先配置 NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY。</p>
          </div>
        </div>
      </div>
    );
  }

  const supabase = await createAdminServerClient();
  const { data, error } = await supabase.from("providers").select("*");

  if (error) {
    return (
      <div className="page active">
        <div className="page-header">
          <div>
            <h1 className="page-title">Provider 管理</h1>
            <p className="page-subtitle">加载 Provider 数据失败。</p>
          </div>
        </div>
        <div className="alert alert-danger">{error.message}</div>
      </div>
    );
  }

  return <ProviderManager providers={(data ?? []) as unknown as ProviderRow[]} />;
}
