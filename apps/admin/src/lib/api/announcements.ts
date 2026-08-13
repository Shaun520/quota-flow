import { createAdminBrowserClient } from "@/lib/supabase/client";

export type AnnouncementKind = "notice" | "update";
export type AnnouncementKindFilter = "" | AnnouncementKind;

export interface AdminAnnouncement {
  id: string;
  title: string;
  content: string;
  kind: AnnouncementKind;
  target: "all" | "team";
  team_id: string | null;
  created_by: string | null;
  published: boolean;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export interface AnnouncementInput {
  title: string;
  content: string;
  kind: AnnouncementKind;
  published: boolean;
}

export interface AnnouncementListParams {
  search?: string;
  kind?: AnnouncementKindFilter;
}

export async function listAnnouncements(params: AnnouncementListParams = {}): Promise<AdminAnnouncement[]> {
  const supabase = createAdminBrowserClient();
  let query = supabase
    .from("announcements")
    .select("*")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(500);

  const search = params.search?.trim();
  if (search) {
    query = query.ilike("title", `%${search}%`);
  }
  if (params.kind) {
    query = query.eq("kind", params.kind);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AdminAnnouncement[];
}

export async function createAnnouncement(input: AnnouncementInput): Promise<AdminAnnouncement> {
  const supabase = createAdminBrowserClient();
  const { data: authData } = await supabase.auth.getUser();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("announcements")
    .insert({
      title: input.title.trim(),
      content: input.content.trim(),
      kind: input.kind,
      target: "all",
      published: input.published,
      created_by: authData.user?.id ?? null,
      updated_at: now
    })
    .select("*")
    .single();
  if (error) throw error;

  await insertAuditLog("announcement.create", data.id, {
    title: data.title,
    kind: data.kind,
    published: data.published
  });
  return data as AdminAnnouncement;
}

export async function updateAnnouncement(id: string, input: AnnouncementInput): Promise<AdminAnnouncement> {
  const supabase = createAdminBrowserClient();

  const { data, error } = await supabase
    .from("announcements")
    .update({
      title: input.title.trim(),
      content: input.content.trim(),
      kind: input.kind,
      published: input.published,
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  await insertAuditLog("announcement.update", id, {
    title: data.title,
    kind: data.kind,
    published: data.published
  });
  return data as AdminAnnouncement;
}

export async function deleteAnnouncement(id: string, title: string): Promise<void> {
  const supabase = createAdminBrowserClient();

  const { error } = await supabase
    .from("announcements")
    .update({
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", id);
  if (error) throw error;

  await insertAuditLog("announcement.delete", id, { title });
}

export async function toggleAnnouncementPublished(id: string, published: boolean, title: string): Promise<void> {
  const supabase = createAdminBrowserClient();

  const { error } = await supabase
    .from("announcements")
    .update({
      published,
      updated_at: new Date().toISOString()
    })
    .eq("id", id);
  if (error) throw error;

  await insertAuditLog(published ? "announcement.publish" : "announcement.unpublish", id, { title });
}

export function kindLabel(kind: AnnouncementKind): string {
  return kind === "update" ? "版本更新" : "公告";
}

export function publishedLabel(published: boolean): string {
  return published ? "已发布" : "草稿";
}

async function insertAuditLog(action: string, target: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    const supabase = createAdminBrowserClient();
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user?.id) return;
    await supabase.from("audit_logs").insert({
      admin_user_id: authData.user.id,
      action,
      target,
      metadata
    });
  } catch {
    // 审计失败不阻断主操作，避免公告管理被日志写入影响。
  }
}
