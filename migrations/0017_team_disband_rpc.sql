-- 0017_team_disband_rpc.sql
-- Desktop team owner can disband a team.
-- Shared provider keys are unshared before team deletion; team-scoped ledger and
-- member usage rows are cleaned up so the team does not leave hidden stale rows.
-- Idempotent: uses CREATE OR REPLACE FUNCTION and explicit GRANTs.

CREATE OR REPLACE FUNCTION public.team_disband(p_team_id UUID)
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
    SELECT 1
    FROM public.teams t
    WHERE t.id = p_team_id
      AND t.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: only team owner can disband team' USING ERRCODE = '42501';
  END IF;

  UPDATE public.provider_keys
  SET team_id = NULL
  WHERE team_id = p_team_id;

  DELETE FROM public.quota_ledger
  WHERE team_id = p_team_id;

  DELETE FROM public.member_usage
  WHERE team_id = p_team_id;

  DELETE FROM public.teams
  WHERE id = p_team_id
    AND owner_id = v_user_id;

  RETURN json_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.team_disband(uuid) TO authenticated;

COMMENT ON FUNCTION public.team_disband(uuid)
  IS 'Disband a team. Only the team owner can disband; all provider keys shared to the team are returned to personal scope.';
