import { ProviderManager } from "@/components/provider-manager";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export default function ProvidersPage() {
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

  return <ProviderManager providers={[]} />;
}
