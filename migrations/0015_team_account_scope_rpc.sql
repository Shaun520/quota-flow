-- 0015_team_account_scope_rpc.sql
-- Desktop team/account scope controls:
--   team_leave             non-owner member leaves team and unshares own team keys
--   set_provider_key_scope own provider key can be moved between personal/team scope
-- Idempotent: uses CREATE OR REPLACE FUNCTION and explicit GRANTs.

-- ============ 1. team_leave ============
CREATE OR REPLACE FUNCTION public.team_leave(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  SELECT tm.role
  INTO v_role
  FROM public.team_members tm
  WHERE tm.team_id = p_team_id
    AND tm.user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
  END IF;

  IF v_role = 'admin' THEN
    RAISE EXCEPTION 'owner cannot leave team';
  END IF;

  DELETE FROM public.team_members
  WHERE team_id = p_team_id AND user_id = v_user_id;

  UPDATE public.provider_keys
  SET team_id = NULL
  WHERE owner_user_id = v_user_id
    AND team_id = p_team_id;

  RETURN json_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.team_leave(uuid) TO authenticated;

COMMENT ON FUNCTION public.team_leave(uuid)
  IS 'Let a non-owner member leave a team and unshare their own provider keys for that team. Owner cannot leave.';

-- ============ 2. set_provider_key_scope ============
CREATE OR REPLACE FUNCTION public.set_provider_key_scope(
  p_key_id UUID,
  p_team_id UUID DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.provider_keys pk
    WHERE pk.id = p_key_id AND pk.owner_user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: not the account owner' USING ERRCODE = '42501';
  END IF;

  IF p_team_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'forbidden: not a member of target team' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.id = p_team_id AND t.status = 'active'
    ) THEN
      RAISE EXCEPTION 'team not active';
    END IF;
  END IF;

  UPDATE public.provider_keys
  SET team_id = p_team_id
  WHERE id = p_key_id AND owner_user_id = v_user_id;

  RETURN json_build_object(
    'ok', true,
    'key_id', p_key_id,
    'team_id', p_team_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_provider_key_scope(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.set_provider_key_scope(uuid, uuid)
  IS 'Set an owned provider key to personal (NULL team_id) or a team where the caller is a member.';

-- ============ 3. Tighten direct provider_key writes ============
DROP POLICY IF EXISTS "provider_keys_insert" ON public.provider_keys;
CREATE POLICY "provider_keys_insert" ON public.provider_keys
  FOR INSERT WITH CHECK (
    owner_user_id = auth.uid()
    AND (
      team_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.team_id = provider_keys.team_id
          AND tm.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "provider_keys_update_own" ON public.provider_keys;
CREATE POLICY "provider_keys_update_own" ON public.provider_keys
  FOR UPDATE USING (owner_user_id = auth.uid())
  WITH CHECK (
    owner_user_id = auth.uid()
    AND (
      team_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.team_id = provider_keys.team_id
          AND tm.user_id = auth.uid()
      )
    )
  );
