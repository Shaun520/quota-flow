-- 0009_provider_logo_storage.sql
-- Public storage bucket for provider logos uploaded from the admin console.
-- Idempotent: run in Supabase SQL Editor or via migration runner.

INSERT INTO storage.buckets (id, name, public)
VALUES ('provider-logos', 'provider-logos', TRUE)
ON CONFLICT (id) DO UPDATE SET public = TRUE;

DROP POLICY IF EXISTS "provider-logos public read" ON storage.objects;
CREATE POLICY "provider-logos public read"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'provider-logos');

DROP POLICY IF EXISTS "provider-logos admin insert" ON storage.objects;
CREATE POLICY "provider-logos admin insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'provider-logos' AND public.is_admin());

DROP POLICY IF EXISTS "provider-logos admin update" ON storage.objects;
CREATE POLICY "provider-logos admin update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'provider-logos' AND public.is_admin())
  WITH CHECK (bucket_id = 'provider-logos' AND public.is_admin());

DROP POLICY IF EXISTS "provider-logos admin delete" ON storage.objects;
CREATE POLICY "provider-logos admin delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'provider-logos' AND public.is_admin());

GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT ALL ON storage.objects TO authenticated;
