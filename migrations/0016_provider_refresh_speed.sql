-- 0016_provider_refresh_speed.sql
-- Provider list refresh speed:
--   - team ledger today query index
--   - ensure_provider_ledger_rows batch-initializes today rows for many keys in one RPC
-- Idempotent: CREATE OR REPLACE + IF NOT EXISTS + explicit GRANTs.

CREATE INDEX IF NOT EXISTS idx_quota_ledger_team_date
  ON public.quota_ledger (team_id, date DESC);

CREATE OR REPLACE FUNCTION public.ensure_provider_ledger_rows(
  p_user_id UUID,
  p_team_id UUID DEFAULT NULL,
  p_key_ids UUID[] DEFAULT '{}'::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_today DATE := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_rows JSON;
BEGIN
  IF v_user_id IS NULL OR p_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF p_team_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.provider_keys pk
      WHERE pk.id = ANY(p_key_ids)
        AND (pk.owner_user_id <> v_user_id OR pk.team_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'forbidden: personal scope only' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM public.team_members tm
      WHERE tm.team_id = p_team_id
        AND tm.user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.teams t
      WHERE t.id = p_team_id
        AND t.status = 'active'
    ) THEN
      RAISE EXCEPTION 'team not active';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.provider_keys pk
      WHERE pk.id = ANY(p_key_ids)
        AND pk.team_id IS DISTINCT FROM p_team_id
    ) THEN
      RAISE EXCEPTION 'forbidden: team scope mismatch' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.quota_ledger (
    date,
    team_id,
    owner_user_id,
    account_key_id,
    provider_id,
    unit_name,
    daily_total,
    used,
    remaining,
    reserved
  )
  SELECT
    v_today,
    pk.team_id,
    pk.owner_user_id,
    pk.id,
    pk.provider_id,
    COALESCE(p.unit_name, '点'),
    COALESCE(pk.daily_quota, p.default_daily_quota, 0),
    0,
    COALESCE(pk.daily_quota, p.default_daily_quota, 0),
    0
  FROM public.provider_keys pk
  JOIN public.providers p ON p.id = pk.provider_id
  WHERE pk.id = ANY(p_key_ids)
    AND NOT EXISTS (
      SELECT 1
      FROM public.quota_ledger l
      WHERE l.date = v_today
        AND l.team_id IS NOT DISTINCT FROM pk.team_id
        AND l.owner_user_id IS NOT DISTINCT FROM pk.owner_user_id
        AND l.account_key_id = pk.id
        AND l.provider_id = pk.provider_id
    )
  ON CONFLICT DO NOTHING;

  SELECT COALESCE(json_agg(l ORDER BY l.account_key_id), '[]'::json)
  INTO v_rows
  FROM public.quota_ledger l
  WHERE l.date = v_today
    AND l.account_key_id = ANY(p_key_ids)
    AND l.team_id IS NOT DISTINCT FROM p_team_id;

  RETURN v_rows::jsonb;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_provider_ledger_rows(uuid, uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.ensure_provider_ledger_rows(uuid, uuid, uuid[])
  IS 'Batch-ensure today quota_ledger rows for owned personal keys or keys shared to a team the caller belongs to. Owner/team-member only.';
