-- 0013_team_rpc.sql
-- Team module RPCs for admin management and desktop create/join flows.
-- Idempotent: uses CREATE OR REPLACE FUNCTION and explicit GRANTs.

-- ============ 1. admin_list_teams ============
CREATE OR REPLACE FUNCTION public.admin_list_teams(
  p_search TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_total BIGINT;
  v_items JSON;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)
  INTO v_total
  FROM teams t
  LEFT JOIN profiles owner ON owner.id = t.owner_id
  WHERE
    (p_search IS NULL OR p_search = '' OR t.name ILIKE '%' || p_search || '%' OR owner.email ILIKE '%' || p_search || '%' OR owner.display_name ILIKE '%' || p_search || '%')
    AND (p_status IS NULL OR p_status = '' OR t.status = p_status);

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      t.id,
      t.name,
      t.owner_id,
      owner.email AS owner_email,
      owner.display_name AS owner_name,
      owner.status AS owner_status,
      t.plan,
      t.seats_limit,
      t.status,
      t.created_at,
      (
        SELECT count(*)
        FROM team_members tm
        WHERE tm.team_id = t.id
      ) AS member_count,
      (
        SELECT count(*)
        FROM team_members tm
        JOIN profiles mp ON mp.id = tm.user_id
        WHERE tm.team_id = t.id
          AND mp.status = 'active'
      ) AS active_member_count,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = t.id
          AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      ), 0) AS month_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = t.id
      ), 0) AS total_usage,
      (
        SELECT count(*)
        FROM provider_keys pk
        WHERE pk.team_id = t.id
      ) AS key_count
    FROM teams t
    LEFT JOIN profiles owner ON owner.id = t.owner_id
    WHERE
      (p_search IS NULL OR p_search = '' OR t.name ILIKE '%' || p_search || '%' OR owner.email ILIKE '%' || p_search || '%' OR owner.display_name ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status = '' OR t.status = p_status)
    ORDER BY t.created_at DESC, t.id
    LIMIT p_limit OFFSET p_offset
  ) item;

  RETURN json_build_object(
    'total', v_total,
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_teams(text, text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_list_teams(text, text, integer, integer)
  IS 'Admin team list with owner, members, usage, and key count. Admin only.';

-- ============ 2. admin_list_team_members ============
CREATE OR REPLACE FUNCTION public.admin_list_team_members(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_items JSON;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      tm.team_id,
      tm.user_id,
      p.email,
      p.display_name,
      p.status,
      tm.role,
      tm.daily_quota_limit_equivalent,
      tm.joined_at,
      (
        SELECT mu.used_equivalent
        FROM member_usage mu
        WHERE mu.team_id = tm.team_id
          AND mu.user_id = tm.user_id
          AND mu.date = (now() AT TIME ZONE 'Asia/Shanghai')::date
        LIMIT 1
      ) AS today_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = tm.team_id
          AND j.user_id = tm.user_id
          AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      ), 0) AS month_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = tm.team_id
          AND j.user_id = tm.user_id
      ), 0) AS total_usage
    FROM team_members tm
    JOIN profiles p ON p.id = tm.user_id
    WHERE tm.team_id = p_team_id
    ORDER BY tm.joined_at, tm.user_id
  ) item;

  RETURN json_build_object(
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_team_members(uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_list_team_members(uuid)
  IS 'Admin team member detail list. Admin only.';

-- ============ 3. create_team ============
CREATE OR REPLACE FUNCTION public.create_team(p_name TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_team_id UUID;
  v_member_exists BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'team name is required';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM team_members tm WHERE tm.user_id = v_user_id
  ) INTO v_member_exists;

  IF v_member_exists THEN
    RAISE EXCEPTION 'already in a team';
  END IF;

  INSERT INTO teams (name, owner_id, plan, seats_limit, status)
  VALUES (trim(p_name), v_user_id, 'free', 3, 'active')
  RETURNING id INTO v_team_id;

  INSERT INTO team_members (team_id, user_id, role)
  VALUES (v_team_id, v_user_id, 'admin');

  RETURN json_build_object(
    'ok', true,
    'team', json_build_object('id', v_team_id, 'role', 'admin')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_team(text) TO authenticated;

COMMENT ON FUNCTION public.create_team(text)
  IS 'Create a team with the signed-in user as owner/admin member.';

-- ============ 4. join_team_by_invite ============
CREATE OR REPLACE FUNCTION public.join_team_by_invite(p_token TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_invite_id UUID;
  v_team_id UUID;
  v_role TEXT;
  v_member_count INTEGER;
  v_seats_limit INTEGER;
  v_team_status TEXT;
  v_member_exists BOOLEAN;
  v_inserted_user UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF p_token IS NULL OR trim(p_token) = '' THEN
    RAISE EXCEPTION 'invite token is required';
  END IF;

  SELECT
    i.id,
    i.team_id,
    COALESCE(NULLIF(i.role, ''), 'member'),
    t.seats_limit,
    t.status
  INTO
    v_invite_id,
    v_team_id,
    v_role,
    v_seats_limit,
    v_team_status
  FROM team_invitations i
  JOIN teams t ON t.id = i.team_id
  WHERE i.token = upper(trim(p_token))
  LIMIT 1
  FOR UPDATE OF i;

  IF v_invite_id IS NULL THEN
    RAISE EXCEPTION 'invalid invite';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM team_invitations i
    WHERE i.id = v_invite_id
      AND i.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'invite expired';
  END IF;

  IF v_team_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'team not active';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM team_members tm WHERE tm.user_id = v_user_id
  ) INTO v_member_exists;

  IF v_member_exists THEN
    RAISE EXCEPTION 'already in a team';
  END IF;

  SELECT count(*)
  INTO v_member_count
  FROM team_members tm
  WHERE tm.team_id = v_team_id;

  IF v_member_count >= v_seats_limit THEN
    RAISE EXCEPTION 'team seats full';
  END IF;

  INSERT INTO team_members (team_id, user_id, role)
  VALUES (v_team_id, v_user_id, v_role)
  ON CONFLICT (team_id, user_id) DO NOTHING
  RETURNING user_id INTO v_inserted_user;

  IF v_inserted_user IS NULL THEN
    RAISE EXCEPTION 'already in team';
  END IF;

  DELETE FROM team_invitations WHERE id = v_invite_id;

  RETURN json_build_object(
    'ok', true,
    'team', json_build_object('id', v_team_id, 'role', v_role)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_team_by_invite(text) TO authenticated;

COMMENT ON FUNCTION public.join_team_by_invite(text)
  IS 'Join a team by a one-time 8-character invite token. Consumes the invitation.';

-- ============ 5. get_team_detail ============
CREATE OR REPLACE FUNCTION public.get_team_detail(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_row JSON;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
  END IF;

  SELECT json_build_object(
    'id', t.id,
    'name', t.name,
    'owner_id', t.owner_id,
    'owner_email', owner.email,
    'owner_name', owner.display_name,
    'owner_status', owner.status,
    'plan', t.plan,
    'seats_limit', t.seats_limit,
    'status', t.status,
    'created_at', t.created_at,
    'member_count', (
      SELECT count(*) FROM team_members tm
      WHERE tm.team_id = t.id
    ),
    'active_member_count', (
      SELECT count(*) FROM team_members tm
      JOIN profiles mp ON mp.id = tm.user_id
      WHERE tm.team_id = t.id AND mp.status = 'active'
    ),
    'month_usage', COALESCE((
      SELECT SUM(COALESCE(j.equivalent_count, 0))
      FROM jobs j
      WHERE j.team_id = t.id
        AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
    ), 0),
    'total_usage', COALESCE((
      SELECT SUM(COALESCE(j.equivalent_count, 0))
      FROM jobs j
      WHERE j.team_id = t.id
    ), 0),
    'key_count', (
      SELECT count(*) FROM provider_keys pk
      WHERE pk.team_id = t.id
    ),
    'current_user_role', (
      SELECT tm.role FROM team_members tm
      WHERE tm.team_id = t.id AND tm.user_id = v_user_id
    )
  )
  INTO v_row
  FROM teams t
  LEFT JOIN profiles owner ON owner.id = t.owner_id
  WHERE t.id = p_team_id;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'team not found';
  END IF;

  RETURN json_build_object('team', v_row);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_detail(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_team_detail(uuid)
  IS 'Team detail for the signed-in member, including owner profile and usage summary.';

-- ============ 6. get_team_members ============
CREATE OR REPLACE FUNCTION public.get_team_members(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_items JSON;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      tm.team_id,
      tm.user_id,
      p.email,
      p.display_name,
      p.status,
      tm.role,
      tm.daily_quota_limit_equivalent,
      tm.joined_at,
      (
        SELECT mu.used_equivalent
        FROM member_usage mu
        WHERE mu.team_id = tm.team_id
          AND mu.user_id = tm.user_id
          AND mu.date = (now() AT TIME ZONE 'Asia/Shanghai')::date
        LIMIT 1
      ) AS today_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = tm.team_id
          AND j.user_id = tm.user_id
          AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      ), 0) AS month_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = tm.team_id
          AND j.user_id = tm.user_id
      ), 0) AS total_usage
    FROM team_members tm
    JOIN profiles p ON p.id = tm.user_id
    WHERE tm.team_id = p_team_id
    ORDER BY tm.joined_at, tm.user_id
  ) item;

  RETURN json_build_object('items', v_items);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_members(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_team_members(uuid)
  IS 'Team member list for the signed-in member, including profile and usage stats.';

-- ============ 7. create_team_invite ============
CREATE OR REPLACE FUNCTION public.create_team_invite(
  p_team_id UUID,
  p_email TEXT DEFAULT NULL,
  p_role TEXT DEFAULT 'member',
  p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_token TEXT;
  v_invite_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_member_count INTEGER;
  v_seats_limit INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM teams t WHERE t.id = p_team_id AND t.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: only team owner can create invites' USING ERRCODE = '42501';
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('member', 'admin') THEN
    RAISE EXCEPTION 'invalid invite role';
  END IF;

  SELECT t.seats_limit INTO v_seats_limit
  FROM teams t WHERE t.id = p_team_id;

  SELECT count(*) INTO v_member_count
  FROM team_members tm WHERE tm.team_id = p_team_id;

  IF v_member_count >= v_seats_limit THEN
    RAISE EXCEPTION 'team seats full';
  END IF;

  v_token := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_expires_at := COALESCE(p_expires_at, now() + interval '7 days');

  IF v_expires_at <= now() THEN
    RAISE EXCEPTION 'invite expires_at must be in the future';
  END IF;

  INSERT INTO team_invitations (team_id, email, role, token, expires_at)
  VALUES (p_team_id, NULLIF(trim(p_email), ''), p_role, v_token, v_expires_at)
  RETURNING id INTO v_invite_id;

  RETURN json_build_object(
    'invite', json_build_object(
      'id', v_invite_id,
      'team_id', p_team_id,
      'email', NULLIF(trim(p_email), ''),
      'role', p_role,
      'token', v_token,
      'expires_at', v_expires_at,
      'created_at', now()
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_team_invite(uuid, text, text, timestamptz) TO authenticated;

COMMENT ON FUNCTION public.create_team_invite(uuid, text, text, timestamptz)
  IS 'Create a one-time 7-day invite token for a team owner.';
