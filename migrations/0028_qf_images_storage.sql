-- 0028_qf_images_storage.sql
-- Public storage bucket for user-uploaded video-generating reference images.
-- 说明：智谱等开放平台 API 要求 image_url 必须是可公网访问的 http(s) 地址，
--       因此存储桶设为 public，生成 https 公开 URL 后透传给厂商。
-- Idempotent: run in Supabase SQL Editor or via migration runner.

INSERT INTO storage.buckets (id, name, public)
VALUES ('qf-images', 'qf-images', TRUE)
ON CONFLICT (id) DO UPDATE SET public = TRUE;

-- 公开读：厂商服务端可直接拉取 https URL
DROP POLICY IF EXISTS "qf-images public read" ON storage.objects;
CREATE POLICY "qf-images public read"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'qf-images');

-- 写入：仅登录用户，且只能写入自己目录（第一段 = auth.uid()）
-- 约定路径: <uid>/<uuid>.<ext>
DROP POLICY IF EXISTS "qf-images owner insert" ON storage.objects;
CREATE POLICY "qf-images owner insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'qf-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "qf-images owner update" ON storage.objects;
CREATE POLICY "qf-images owner update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'qf-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'qf-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "qf-images owner delete" ON storage.objects;
CREATE POLICY "qf-images owner delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'qf-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT ALL ON storage.objects TO authenticated;