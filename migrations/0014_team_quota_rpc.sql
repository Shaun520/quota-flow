-- 0014_team_quota_rpc.sql
-- Team shared quota pool RPCs.
-- Uses existing quota_ledger rows with team_id NOT NULL, owner_user_id NULL,
-- account_key_id NULL as the team-level daily pool.
-- Idempotent: uses CREATE OR REPLACE and explicit GRANTs.

-- ============ 0. Team pool ledger uniqueness ============
-- quota_ledger UNIQUE (date, team_id, owner_user_id, account_key_id, provider_id)
-- does not protect team pool rows because both owner_user_id and account_key_id
-- are NULL. Use a partial unique index for the team-level aggregate row.
DROP INDEX IF EXISTS idx_quota_ledger_unique_team_pool;
CREATE UNIQUE INDEX idx_quota_ledger_unique_team_pool
  ON public.quota_ledger (date, team_id, provider_id)
  WHERE team_id IS NOT NULL AND owner_user_id IS NULL AND account_key_id IS NULL;

-- ============ 1. team_quota_snapshot ============
CREATE OR REPLACE FUNCTION public.team_quota_snapshot(
  p_team_id UUID,
  p_provider_id TEXT DEFAULT 'doubao'
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_daily_total NUMERIC;
  v_used NUMERIC;
  v_reserved NUMERIC;
BEGIN
  IF NOT public.is_admin()
     AND NOT EXISTS (
       SELECT 1 FROM public.team_members tm
       WHERE tm.team_id = p_team_id AND tm.user_id = auth.uid()
     ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(SUM(COALESCE(pk.daily_quota, p.default_daily_quota, 0)), 0)
  INTO v_daily_total
  FROM public.provider_keys pk
  JOIN public.providers p ON p.id = pk.provider_id
  WHERE pk.team_id = p_team_id
    AND pk.provider_id = p_provider_id
    AND pk.enabled = true;

  SELECT COALESCE(SUM(l.used), 0), COALESCE(SUM(l.reserved), 0)
  INTO v_used, v_reserved
  FROM public.quota_ledger l
  WHERE l.date = (now() AT TIME ZONE 'Asia/Shanghai')::date
    AND l.team_id = p_team_id
    AND l.owner_user_id IS NULL
    AND l.account_key_id IS NULL
    AND l.provider_id = p_provider_id;

  RETURN json_build_object(
    'provider_id', p_provider_id,
    'daily_total', v_daily_total,
    'used', COALESCE(v_used, 0),
    'remaining', GREATEST(v_daily_total - COALESCE(v_used, 0) - COALESCE(v_reserved, 0), 0),
    'reserved', COALESCE(v_reserved, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.team_quota_snapshot(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.team_quota_snapshot(uuid, text)
  IS 'Return team daily shared quota summary for a provider. Admin or team member only.';

-- ============ 2. get_team_quota ============
CREATE OR REPLACE FUNCTION public.get_team_quota(
  p_team_id UUID,
  p_provider_id TEXT DEFAULT 'doubao'
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_today DATE := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_member_used NUMERIC;
  v_member_limit NUMERIC;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
  END IF;

  SELECT
    COALESCE((
      SELECT mu.used_equivalent
      FROM public.member_usage mu
      WHERE mu.team_id = p_team_id
        AND mu.user_id = v_user_id
        AND mu.date = v_today
      LIMIT 1
    ), 0),
    tm.daily_quota_limit_equivalent
  INTO v_member_used, v_member_limit
  FROM public.team_members tm
  WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id;

  RETURN json_build_object(
    'team_id', p_team_id,
    'quota', public.team_quota_snapshot(p_team_id, p_provider_id),
    'member_used', v_member_used,
    'member_limit', v_member_limit
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_quota(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.get_team_quota(uuid, text)
  IS 'Team quota summary for the signed-in team member.';

-- ============ 3. team_consume_quota_and_finalize ============
CREATE OR REPLACE FUNCTION public.team_consume_quota_and_finalize(
  p_team_id UUID,
  p_user_id UUID,
  p_provider_id TEXT,
  p_amount NUMERIC,
  p_account_key_id UUID,
  p_date DATE,
  p_job_id UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_today DATE := COALESCE(p_date, (now() AT TIME ZONE 'Asia/Shanghai')::date);
  v_op_exists BOOLEAN;
  v_team_status TEXT;
  v_daily_total NUMERIC;
  v_pool public.quota_ledger%ROWTYPE;
  v_account public.quota_ledger%ROWTYPE;
  v_account_total NUMERIC;
  v_member_used NUMERIC;
  v_member_limit NUMERIC;
  v_pool_id UUID;
BEGIN
  IF v_user_id IS NULL OR p_user_id IS DISTINCT FROM v_user_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'forbidden');
  END IF;

  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', 'amount must be greater than 0');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'not a team member');
  END IF;

  SELECT status INTO v_team_status FROM public.teams WHERE id = p_team_id;
  IF v_team_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TEAM_NOT_ACTIVE', 'message', 'team not active');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('team_quota:' || p_team_id::text || ':' || v_today::text, 0));

  IF p_job_id IS NOT NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM public.quota_operations
      WHERE job_id = p_job_id AND operation_type = 'finalize'
    ) INTO v_op_exists;

    IF v_op_exists THEN
      RETURN jsonb_build_object(
        'ok', true,
        'code', 'ALREADY_FINALIZED',
        'message', 'job already finalized'
      );
    END IF;
  END IF;

  SELECT COALESCE(SUM(COALESCE(pk.daily_quota, p.default_daily_quota, 0)), 0)
  INTO v_daily_total
  FROM public.provider_keys pk
  JOIN public.providers p ON p.id = pk.provider_id
  WHERE pk.team_id = p_team_id
    AND pk.provider_id = p_provider_id
    AND pk.enabled = true;

  SELECT * INTO v_pool
  FROM public.quota_ledger
  WHERE date = v_today
    AND team_id = p_team_id
    AND owner_user_id IS NULL
    AND account_key_id IS NULL
    AND provider_id = p_provider_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.quota_ledger (
      date, team_id, owner_user_id, account_key_id, provider_id,
      unit_name, daily_total, used, remaining, reserved
    )
    VALUES (
      v_today, p_team_id, NULL, NULL, p_provider_id,
      'points', v_daily_total, 0, v_daily_total, 0
    )
    ON CONFLICT (date, team_id, provider_id)
    WHERE team_id IS NOT NULL AND owner_user_id IS NULL AND account_key_id IS NULL
    DO UPDATE SET
      daily_total = EXCLUDED.daily_total,
      remaining = GREATEST(EXCLUDED.daily_total - quota_ledger.used - quota_ledger.reserved, 0),
      refreshed_at = now()
    RETURNING * INTO v_pool;
  ELSE
    UPDATE public.quota_ledger
    SET daily_total = v_daily_total,
        remaining = GREATEST(v_daily_total - used - reserved, 0),
        refreshed_at = now()
    WHERE id = v_pool.id
    RETURNING * INTO v_pool;
  END IF;

  IF v_pool.daily_total - COALESCE(v_pool.used, 0) - COALESCE(v_pool.reserved, 0) < p_amount THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'QUOTA_EXHAUSTED',
      'message', format('team quota exhausted: need %s, available %s',
        p_amount,
        v_pool.daily_total - COALESCE(v_pool.used, 0) - COALESCE(v_pool.reserved, 0)),
      'row', row_to_json(v_pool)::jsonb
    );
  END IF;

  SELECT COALESCE(mu.used_equivalent, 0), tm.daily_quota_limit_equivalent
  INTO v_member_used, v_member_limit
  FROM public.team_members tm
  LEFT JOIN public.member_usage mu
    ON mu.team_id = tm.team_id
   AND mu.user_id = tm.user_id
   AND mu.date = v_today
  WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  FOR UPDATE OF tm;

  IF v_member_limit IS NOT NULL AND COALESCE(v_member_used, 0) + p_amount > v_member_limit THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'MEMBER_QUOTA_EXCEEDED',
      'message', format('member daily limit exceeded: need %s, remaining %s',
        p_amount,
        GREATEST(v_member_limit - COALESCE(v_member_used, 0), 0))
    );
  END IF;

  IF p_account_key_id IS NOT NULL THEN
    SELECT COALESCE(pk.daily_quota, p.default_daily_quota, 0)
    INTO v_account_total
    FROM public.provider_keys pk
    JOIN public.providers p ON p.id = pk.provider_id
    WHERE pk.id = p_account_key_id
      AND pk.team_id = p_team_id
      AND pk.provider_id = p_provider_id
      AND pk.enabled = true;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ACCOUNT_NOT_FOUND', 'message', 'team account not found or disabled');
    END IF;

    SELECT * INTO v_account
    FROM public.quota_ledger
    WHERE date = v_today
      AND team_id = p_team_id
      AND account_key_id = p_account_key_id
      AND provider_id = p_provider_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.quota_ledger (
        date, team_id, owner_user_id, account_key_id, provider_id,
        unit_name, daily_total, used, remaining, reserved
      )
      SELECT
        v_today, p_team_id, pk.owner_user_id, pk.id, p_provider_id,
        COALESCE(pr.unit_name, 'points'), v_account_total, 0, v_account_total, 0
      FROM public.provider_keys pk
      JOIN public.providers pr ON pr.id = pk.provider_id
      WHERE pk.id = p_account_key_id
      ON CONFLICT (date, team_id, owner_user_id, account_key_id, provider_id)
      DO UPDATE SET
        daily_total = EXCLUDED.daily_total,
        remaining = GREATEST(EXCLUDED.daily_total - quota_ledger.used - quota_ledger.reserved, 0),
        refreshed_at = now()
      RETURNING * INTO v_account;
    ELSE
      UPDATE public.quota_ledger
      SET daily_total = v_account_total,
          remaining = GREATEST(v_account_total - used - reserved, 0),
          refreshed_at = now()
      WHERE id = v_account.id
      RETURNING * INTO v_account;
    END IF;

    IF v_account.daily_total - COALESCE(v_account.used, 0) - COALESCE(v_account.reserved, 0) < p_amount THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'ACCOUNT_QUOTA_EXHAUSTED',
        'message', 'team account quota exhausted',
        'row', row_to_json(v_account)::jsonb
      );
    END IF;
  END IF;

  UPDATE public.quota_ledger
  SET used = used + p_amount,
      remaining = GREATEST(daily_total - used - p_amount - reserved, 0),
      refreshed_at = now()
  WHERE id = v_pool.id
  RETURNING * INTO v_pool;

  IF p_account_key_id IS NOT NULL THEN
    UPDATE public.quota_ledger
    SET used = used + p_amount,
        remaining = GREATEST(daily_total - used - p_amount - reserved, 0),
        refreshed_at = now()
    WHERE id = v_account.id;
  END IF;

  INSERT INTO public.member_usage (date, team_id, user_id, used_equivalent)
  VALUES (v_today, p_team_id, v_user_id, p_amount)
  ON CONFLICT (date, team_id, user_id)
  DO UPDATE SET used_equivalent = public.member_usage.used_equivalent + EXCLUDED.used_equivalent;

  v_pool_id := v_pool.id;

  IF p_job_id IS NOT NULL THEN
    INSERT INTO public.quota_operations (job_id, ledger_id, operation_type, amount)
    VALUES (p_job_id, v_pool_id, 'finalize', p_amount)
    ON CONFLICT (job_id, operation_type) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'CONSUMED',
    'message', 'team shared quota consumed',
    'row', row_to_json(v_pool)::jsonb,
    'quota', public.team_quota_snapshot(p_team_id, p_provider_id)
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'DB_ERROR',
      'message', SQLERRM
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.team_consume_quota_and_finalize(uuid, uuid, text, numeric, uuid, date, uuid) TO authenticated;

COMMENT ON FUNCTION public.team_consume_quota_and_finalize(uuid, uuid, text, numeric, uuid, date, uuid)
  IS 'Atomic team shared quota consume + member usage + quota_operations finalize. Team member only.';

-- ============ 4. admin_reset_team_quota ============
CREATE OR REPLACE FUNCTION public.admin_reset_team_quota(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_today DATE := (now() AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('team_quota:' || p_team_id::text || ':' || v_today::text, 0));

  UPDATE public.quota_ledger
  SET used = 0,
      remaining = daily_total,
      reserved = 0,
      refreshed_at = now()
  WHERE date = v_today
    AND team_id = p_team_id;

  UPDATE public.member_usage
  SET used_equivalent = 0
  WHERE date = v_today
    AND team_id = p_team_id;

  UPDATE public.teams
  SET status = 'active'
  WHERE id = p_team_id AND status = 'exhausted';

  INSERT INTO public.audit_logs (admin_user_id, team_id, action, target, metadata)
  VALUES (
    v_admin_id,
    p_team_id,
    'quota.reset',
    p_team_id::text,
    json_build_object('date', v_today)
  );

  RETURN json_build_object(
    'ok', true,
    'team_id', p_team_id,
    'date', v_today
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_reset_team_quota(uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_reset_team_quota(uuid)
  IS 'Reset today team shared quota, account ledgers, and member usage. Admin only.';

-- ============ 5. Extend admin_list_teams with quota ============
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
      (
        SELECT json_build_object(
          'plan', s.plan,
          'status', s.status,
          'seats', s.seats,
          'current_period_start', s.current_period_start,
          'current_period_end', s.current_period_end
        )
        FROM subscriptions s
        WHERE s.team_id = t.id
        ORDER BY s.created_at DESC
        LIMIT 1
      ) AS subscription,
      public.team_quota_snapshot(t.id, 'doubao') AS quota,
      COALESCE((SELECT SUM(COALESCE(j.equivalent_count, 0)) FROM jobs j WHERE j.team_id = t.id AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'), 0) AS month_usage,
      COALESCE((SELECT SUM(COALESCE(j.equivalent_count, 0)) FROM jobs j WHERE j.team_id = t.id), 0) AS total_usage,
      (SELECT count(*) FROM provider_keys pk WHERE pk.team_id = t.id) AS key_count
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
  IS 'Admin team list with owner, members, subscription, shared quota, usage, and key count. Admin only.';

-- ============ 6. Extend get_team_detail with quota ============
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
    'member_count', (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id),
    'active_member_count', (SELECT count(*) FROM team_members tm JOIN profiles mp ON mp.id = tm.user_id WHERE tm.team_id = t.id AND mp.status = 'active'),
    'subscription', CASE
      WHEN EXISTS (SELECT 1 FROM subscriptions s WHERE s.team_id = t.id)
      THEN (
        SELECT json_build_object(
          'plan', s.plan,
          'status', s.status,
          'seats', s.seats,
          'current_period_start', s.current_period_start,
          'current_period_end', s.current_period_end
        )
        FROM subscriptions s
        WHERE s.team_id = t.id
        ORDER BY s.created_at DESC
        LIMIT 1
      )
      ELSE NULL
    END,
    'quota', public.team_quota_snapshot(t.id, 'doubao'),
    'month_usage', COALESCE((SELECT SUM(COALESCE(j.equivalent_count, 0)) FROM jobs j WHERE j.team_id = t.id AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'), 0),
    'total_usage', COALESCE((SELECT SUM(COALESCE(j.equivalent_count, 0)) FROM jobs j WHERE j.team_id = t.id), 0),
    'key_count', (SELECT count(*) FROM provider_keys pk WHERE pk.team_id = t.id),
    'current_user_role', (SELECT tm.role FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = v_user_id)
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
  IS 'Team detail for the signed-in member, including owner profile, shared quota, and usage summary.';
