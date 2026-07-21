-- ============================================================================
-- 03-staff-deactivate-unassign.sql — deactivating a staff member releases their
-- clients back to the owner pool (issue #52, part of #50 Phase 2).
--
-- Decision: when a staff member is switched off, their clients are immediately
-- unassigned (assigned_staff_id -> NULL) so they return to the owner's pool.
--
-- Enforced by a TRIGGER, not by the dashboard, so it holds even if `active` is
-- flipped from the SQL editor, another tool, or a future screen.
--
-- Because auto-unassign erases *who used to hold* a client, every released
-- client is written to event_logs first, so that history survives.
--
-- ORDER: run after 01-staff-schema.sql and 02-staff-security.sql.
-- Safe to run more than once. Rollback lives in 99-undo-staff-schema.sql.
-- ============================================================================

create or replace function public.release_clients_on_staff_deactivate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  released int;
begin
  -- Only act on the true -> false transition. Renames, email edits and
  -- re-activations must not touch assignments.
  if old.active is not distinct from new.active or new.active then
    return new;
  end if;

  -- Record the history BEFORE clearing it, one row per released client.
  -- Column names match production's event_logs (event_type / created_at).
  --
  -- Best-effort: the audit log must NEVER block the client release. If the
  -- log table's shape ever differs, the release still happens and only the
  -- log line is skipped. (An earlier version referenced a wrong column name
  -- and rolled the whole deactivate back — this guard prevents that class of
  -- failure from ever silently breaking deactivation again.)
  begin
    insert into public.event_logs (operator_id, username, event_type, message, metadata, created_at)
    select p.operator_id,
           p.username,
           'staff',
           format('Unassigned from %s (staff deactivated)', old.name),
           jsonb_build_object(
             'staff_id',   old.id,
             'staff_name', old.name,
             'reason',     'staff_deactivated'
           ),
           now()
    from public.user_profiles p
    where p.assigned_staff_id = old.id;
  exception when others then
    raise notice 'deactivate release: audit log skipped (%)', sqlerrm;
  end;

  update public.user_profiles
  set assigned_staff_id = null
  where assigned_staff_id = old.id;

  get diagnostics released = row_count;
  raise notice 'Staff % deactivated — % client(s) released to owner pool', old.name, released;

  return new;
end;
$$;

comment on function public.release_clients_on_staff_deactivate() is
  'Releases a deactivated staff member''s clients back to the owner pool, logging each one first (issue #52).';

drop trigger if exists trg_staff_deactivate_release on public.staff;
create trigger trg_staff_deactivate_release
  after update of active on public.staff
  for each row
  execute function public.release_clients_on_staff_deactivate();

-- ---------------------------------------------------------------------------
-- Verify — expect the trigger listed once
-- ---------------------------------------------------------------------------
select tgname, tgenabled
from pg_trigger
where tgrelid = 'public.staff'::regclass
  and not tgisinternal;
