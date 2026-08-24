import { createAdminBrowserClient } from "@/lib/supabase/client";

export type CreationVideoStatusFilter = "" | "enabled" | "disabled";

export interface AdminCreationVideo {
  id: string;
  title: string;
  cover_url: string;
  video_url: string | null;
  duration_sec: number;
  category: string;
  tags: string[];
  prompt: string;
  provider_hint: string | null;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string | null;
}

export interface CreationVideoInput {
  title: string;
  cover_url: string;
  video_url?: string | null;
  duration_sec: number;
  category: string;
  tags: string[];
  prompt: string;
  provider_hint?: string | null;
  enabled: boolean;
  sort_order: number;
}

export interface CreationVideoListParams {
  search?: string;
  category?: string;
  status?: CreationVideoStatusFilter;
  page?: number;
  pageSize?: number;
}

export interface CreationVideoListResult {
  total: number;
  items: AdminCreationVideo[];
}

const CREATION_VIDEO_FIELDS =
  "id, title, cover_url, video_url, duration_sec, category, tags, prompt, provider_hint, enabled, sort_order, created_at, updated_at";

export async function listCreationVideos(params: CreationVideoListParams = {}): Promise<CreationVideoListResult> {
  const supabase = createAdminBrowserClient();
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 10;
  const offset = (page - 1) * pageSize;

  let countQuery = supabase.from("creation_videos").select("id", { count: "exact", head: true });
  const countSearch = params.search?.trim();
  if (countSearch) {
    countQuery = countQuery.or(`title.ilike.%${countSearch}%,prompt.ilike.%${countSearch}%`);
  }
  if (params.category?.trim()) {
    countQuery = countQuery.eq("category", params.category.trim());
  }
  if (params.status === "enabled") {
    countQuery = countQuery.eq("enabled", true);
  } else if (params.status === "disabled") {
    countQuery = countQuery.eq("enabled", false);
  }
  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  let listQuery = supabase.from("creation_videos").select(CREATION_VIDEO_FIELDS);
  const listSearch = params.search?.trim();
  if (listSearch) {
    listQuery = listQuery.or(`title.ilike.%${listSearch}%,prompt.ilike.%${listSearch}%`);
  }
  if (params.category?.trim()) {
    listQuery = listQuery.eq("category", params.category.trim());
  }
  if (params.status === "enabled") {
    listQuery = listQuery.eq("enabled", true);
  } else if (params.status === "disabled") {
    listQuery = listQuery.eq("enabled", false);
  }
  listQuery = listQuery
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);
  const { data, error } = await listQuery;
  if (error) throw error;

  return {
    total: Number(count ?? 0),
    items: (data ?? []) as AdminCreationVideo[]
  };
}

export async function createCreationVideo(input: CreationVideoInput): Promise<AdminCreationVideo> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase
    .from("creation_videos")
    .insert({
      title: input.title.trim(),
      cover_url: input.cover_url.trim(),
      video_url: input.video_url?.trim() || null,
      duration_sec: input.duration_sec,
      category: input.category.trim(),
      tags: input.tags,
      prompt: input.prompt.trim(),
      provider_hint: input.provider_hint?.trim() || null,
      enabled: input.enabled,
      sort_order: input.sort_order,
      updated_at: new Date().toISOString()
    })
    .select(CREATION_VIDEO_FIELDS)
    .single();
  if (error) throw error;
  return data as AdminCreationVideo;
}

export async function updateCreationVideo(id: string, input: CreationVideoInput): Promise<AdminCreationVideo> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase
    .from("creation_videos")
    .update({
      title: input.title.trim(),
      cover_url: input.cover_url.trim(),
      video_url: input.video_url?.trim() || null,
      duration_sec: input.duration_sec,
      category: input.category.trim(),
      tags: input.tags,
      prompt: input.prompt.trim(),
      provider_hint: input.provider_hint?.trim() || null,
      enabled: input.enabled,
      sort_order: input.sort_order,
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .select(CREATION_VIDEO_FIELDS)
    .single();
  if (error) throw error;
  return data as AdminCreationVideo;
}

export async function toggleCreationVideoEnabled(id: string, enabled: boolean): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { error } = await supabase
    .from("creation_videos")
    .update({
      enabled,
      updated_at: new Date().toISOString()
    })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteCreationVideo(id: string): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { error } = await supabase.from("creation_videos").delete().eq("id", id);
  if (error) throw error;
}

export async function deleteCreationVideos(ids: string[]): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { error } = await supabase.from("creation_videos").delete().in("id", ids);
  if (error) throw error;
}

export function formatDuration(seconds: number): string {
  return `${seconds}s`;
}

export function statusLabel(enabled: boolean): string {
  return enabled ? "已启用" : "已停用";
}
