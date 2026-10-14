-- ============================================================================
-- 103_ops_audit.sql — Ops Platform Phase 1: the audit log (issue #79)
--
-- ⚠️  RUN ON THE **TEST** SUPABASE PROJECT FIRST. Run 101 and 102 before this.
--
-- Every important change is written to audit_log with who, what, when, and
-- the row before and after. Secrets (passwords, answers, keys) are removed.
-- Bot run-status chatter (status, heartbeats, last seen) is not audited.
-- Nobody can edit, delete or empty audit_log — not even the founder.
-- Following the #53 lesson: an audit failure never blocks the real change;
-- it raises a founder alert instead. Safe to run more than once.
-- ============================================================================

-- Who is acting right now?
create or replace function public.audit_actor_kind()
returns text
language sql stable security definer set search_path = public
as $$
  select case
           when public.auth_staff_id() is not null then
             (select case when s.role = 'owner' then 'founder' else 'staff' end
              from public.staff s where s.id = public.auth_staff_id())
           when public.get_operator_id() is not null then 'bot'
           when public.get_staff_id() is not null then 'staff_extension'
           else 'system'
         end;
$$;

-- Write one audit row. Never raises: on failure it tries to alert the founder.
create or replace function public.audit_write(
  p_operator uuid, p_action text, p_table text, p_row text, p_before jsonb, p_after jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  begin
    insert into public.audit_log (operator_id, actor_staff_id, actor_kind, action,
                                  table_name, row_id, before, after)
    values (p_operator, public.auth_staff_id(), public.audit_actor_kind(), p_action,
            p_table, p_row, p_before, p_after);
  exception when others then
    begin
      if p_operator is not null then
        insert into public.notifications (operator_id, kind, audience, title, body)
        values (p_operator, 'audit_failed', 'founder', 'Audit log write failed',
                format('%s on %s: %s', p_action, p_table, sqlerrm));
      end if;
    exception when others then
      raise warning 'audit_write failed: %', sqlerrm;
    end;
  end;
end;
$$;

-- Row trigger used on every audited table.
create or replace function public.audit_row()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_secret  text[] := array['password_enc','security_a1_enc','security_a2_enc','security_a3_enc',
                            'secrets','staff_key','private_key_locked'];
  v_runtime text[] := array['status','updated_at','is_active','active_device_id','active_device_name',
                            'rate_limited_at','heartbeat_at','last_status','last_seen'];
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
begin
  if tg_op in ('UPDATE','DELETE') then v_old := to_jsonb(old) - v_secret; end if;
  if tg_op in ('INSERT','UPDATE') then v_new := to_jsonb(new) - v_secret; end if;

  -- Only secrets or bot run-status changed: not an audit event.
  if tg_op = 'UPDATE' and (v_old - v_runtime) = (v_new - v_runtime) then
    return null;
  end if;

  v_row := coalesce(v_new, v_old);
  perform public.audit_write(
    (v_row ->> 'operator_id')::uuid,
    lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'profile_id', v_row ->> 'visa_type'),
    v_old,
    v_new);
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['user_profiles','client_billing','staff','payments','expenses',
                           'recurring_expenses','founder_repayments','price_list','bookings',
                           'intake_submissions','files','app_settings','crypto_keys',
                           'expense_categories']
  loop
    execute format('drop trigger if exists trg_audit on public.%I', t);
    execute format('create trigger trg_audit after insert or update or delete on public.%I
                      for each row execute function public.audit_row()', t);
  end loop;
end $$;

-- bot_jobs: audit only who asked (inserts). Status flips every turn are noise.
drop trigger if exists trg_audit on public.bot_jobs;
create trigger trg_audit after insert on public.bot_jobs
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- Append-only guard: blocks edits, deletes and TRUNCATE for every login,
-- even if a rule is ever misconfigured.
-- ---------------------------------------------------------------------------
create or replace function public.audit_log_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only: it cannot be edited or deleted';
end;
$$;

drop trigger if exists trg_audit_log_guard on public.audit_log;
create trigger trg_audit_log_guard before update or delete on public.audit_log
  for each row execute function public.audit_log_guard();

drop trigger if exists trg_audit_log_no_truncate on public.audit_log;
create trigger trg_audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_log_guard();

-- ---------------------------------------------------------------------------
-- Password views. The dashboard calls this BEFORE unlocking a secret locally.
-- Only the founder signed in on the web may view; bots and staff are refused.
-- ---------------------------------------------------------------------------
create or replace function public.log_secret_view(p_profile uuid, p_field text)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_op uuid;
begin
  if not public.is_web_founder() then
    raise exception 'Only the founder can view client passwords.';
  end if;
  if p_field not in ('password','answer1','answer2','answer3') then
    raise exception 'Unknown secret field: %', p_field;
  end if;
  select operator_id into v_op from public.user_profiles
  where id = p_profile and operator_id = public.app_operator_id();
  if v_op is null then
    raise exception 'Client not found.';
  end if;
  -- Not best-effort: if the view cannot be logged, it must not happen.
  insert into public.audit_log (operator_id, actor_staff_id, actor_kind, action, table_name, row_id, after)
  values (v_op, public.auth_staff_id(), 'founder', 'secret_view', 'user_profiles', p_profile::text,
          jsonb_build_object('field', p_field));
end;
$$;

revoke execute on function public.audit_write(uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.audit_row() from public, anon, authenticated;
revoke execute on function public.log_secret_view(uuid, text) from public, anon;
grant  execute on function public.log_secret_view(uuid, text) to authenticated;

-- Verify
select tgrelid::regclass as audited_table
from pg_trigger
where tgname = 'trg_audit'
order by 1;
