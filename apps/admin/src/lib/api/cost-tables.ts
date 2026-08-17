import { createAdminBrowserClient } from "@/lib/supabase/client";

export interface AdminCostRule {
  id: string;
  provider_id: string;
  mode: string;
  duration_min: number | null;
  duration_max: number | null;
  resolution: string | null;
  model: string | null;
  unit_cost: number;
  equivalent_count_divisor: number;
  display_text: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface CostRuleInput {
  provider_id: string;
  mode: string;
  duration_min: number | null;
  duration_max: number | null;
  resolution: string | null;
  model: string | null;
  unit_cost: number;
  equivalent_count_divisor: number;
  display_text: string | null;
}

export interface CostRuleListParams {
  search?: string;
  providerId?: string;
  mode?: string;
  page?: number;
  pageSize?: number;
}

export interface CostRuleListResult {
  total: number;
  items: AdminCostRule[];
}

export interface ProviderOption {
  id: string;
  name: string;
}

const COST_RULE_FIELDS =
  "id, provider_id, mode, duration_min, duration_max, resolution, model, unit_cost, equivalent_count_divisor, display_text, created_at, updated_at";

export async function listCostRules(params: CostRuleListParams = {}): Promise<CostRuleListResult> {
  const supabase = createAdminBrowserClient();
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const search = params.search?.trim();
  const providerId = params.providerId?.trim();
  const mode = params.mode?.trim();

  let countQuery = supabase
    .from("provider_cost_tables")
    .select("id", { count: "exact", head: true });

  if (providerId) {
    countQuery = countQuery.eq("provider_id", providerId);
  }
  if (mode) {
    countQuery = countQuery.eq("mode", mode);
  }
  if (search) {
    countQuery = countQuery.or(`display_text.ilike.%${search}%,mode.ilike.%${search}%`);
  }

  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  let listQuery = supabase
    .from("provider_cost_tables")
    .select(COST_RULE_FIELDS)
    .order("provider_id", { ascending: true })
    .order("mode", { ascending: true })
    .order("duration_min", { ascending: true, nullsFirst: true })
    .range((page - 1) * pageSize, page * pageSize - 1);

  if (providerId) {
    listQuery = listQuery.eq("provider_id", providerId);
  }
  if (mode) {
    listQuery = listQuery.eq("mode", mode);
  }
  if (search) {
    listQuery = listQuery.or(`display_text.ilike.%${search}%,mode.ilike.%${search}%`);
  }

  const { data, error } = await listQuery;
  if (error) throw error;

  return {
    total: Number(count ?? 0),
    items: (data ?? []).map(normalizeCostRule)
  };
}

export async function listProviderOptions(): Promise<ProviderOption[]> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase
    .from("providers")
    .select("id, name")
    .order("id", { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as ProviderOption[];
}

export async function createCostRule(input: CostRuleInput): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { error } = await supabase
    .from("provider_cost_tables")
    .insert(toRulePayload(input));
  if (error) throw error;

  await writeAudit("cost.create", {
    provider_id: input.provider_id,
    mode: input.mode,
    duration_min: input.duration_min,
    duration_max: input.duration_max,
    resolution: input.resolution,
    model: input.model
  });
}

export async function updateCostRule(id: string, input: CostRuleInput): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { error } = await supabase
    .from("provider_cost_tables")
    .update(toRulePayload(input, true))
    .eq("id", id);
  if (error) throw error;

  await writeAudit("cost.update", {
    id,
    provider_id: input.provider_id,
    mode: input.mode,
    duration_min: input.duration_min,
    duration_max: input.duration_max,
    resolution: input.resolution,
    model: input.model
  });
}

export async function deleteCostRule(id: string, displayText: string | null): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { error } = await supabase
    .from("provider_cost_tables")
    .delete()
    .eq("id", id);
  if (error) throw error;

  await writeAudit("cost.delete", {
    id,
    display_text: displayText
  });
}

export async function deleteCostRules(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase
    .from("provider_cost_tables")
    .delete()
    .in("id", ids)
    .select("id");
  if (error) throw error;

  const deletedIds = (data ?? []).map((row) => String((row as Record<string, unknown>).id ?? ""));
  await writeAudit("cost.batchDelete", {
    count: deletedIds.length,
    ids: deletedIds
  });
  return deletedIds.length;
}

export async function upsertCostRules(inputs: CostRuleInput[]): Promise<number> {
  if (inputs.length === 0) return 0;

  const supabase = createAdminBrowserClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("provider_cost_tables")
    .upsert(inputs.map((input) => ({ ...toRulePayload(input), updated_at: now })), {
      onConflict: "provider_id,mode,duration_min,duration_max,resolution,model"
    });
  if (error) throw error;

  await writeAudit("cost.import", {
    count: inputs.length,
    provider_ids: Array.from(new Set(inputs.map((input) => input.provider_id)))
  });
  return inputs.length;
}

export async function exportCostRules(params: Omit<CostRuleListParams, "page" | "pageSize"> = {}): Promise<AdminCostRule[]> {
  const supabase = createAdminBrowserClient();
  const search = params.search?.trim();
  const providerId = params.providerId?.trim();
  const mode = params.mode?.trim();

  let query = supabase
    .from("provider_cost_tables")
    .select(COST_RULE_FIELDS)
    .order("provider_id", { ascending: true })
    .order("mode", { ascending: true })
    .order("duration_min", { ascending: true, nullsFirst: true })
    .limit(5000);

  if (providerId) {
    query = query.eq("provider_id", providerId);
  }
  if (mode) {
    query = query.eq("mode", mode);
  }
  if (search) {
    query = query.or(`display_text.ilike.%${search}%,mode.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map(normalizeCostRule);
}

function toRulePayload(input: CostRuleInput, includeUpdatedAt = false): Record<string, unknown> {
  return {
    provider_id: input.provider_id,
    mode: input.mode.trim(),
    duration_min: input.duration_min,
    duration_max: input.duration_max,
    resolution: input.resolution?.trim() || null,
    model: input.model?.trim() || null,
    unit_cost: input.unit_cost,
    equivalent_count_divisor: input.equivalent_count_divisor,
    display_text: input.display_text?.trim() || null,
    ...(includeUpdatedAt ? { updated_at: new Date().toISOString() } : {})
  };
}

async function writeAudit(action: string, metadata: Record<string, unknown>): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { error } = await supabase.rpc("admin_write_audit_log", {
    p_action: action,
    p_target: "provider_cost_tables",
    p_metadata: metadata
  });
  if (error) throw error;
}

function normalizeCostRule(raw: unknown): AdminCostRule {
  const it = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(it.id ?? ""),
    provider_id: String(it.provider_id ?? ""),
    mode: String(it.mode ?? ""),
    duration_min: toNullableNumber(it.duration_min),
    duration_max: toNullableNumber(it.duration_max),
    resolution: (it.resolution as string | null) ?? null,
    model: (it.model as string | null) ?? null,
    unit_cost: Number(it.unit_cost ?? 0),
    equivalent_count_divisor: Number(it.equivalent_count_divisor ?? 1),
    display_text: (it.display_text as string | null) ?? null,
    created_at: String(it.created_at ?? ""),
    updated_at: (it.updated_at as string | null) ?? null
  };
}

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isNaN(number) ? null : number;
}
