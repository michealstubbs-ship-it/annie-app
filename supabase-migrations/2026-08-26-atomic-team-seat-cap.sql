-- Run this once in the Supabase SQL Editor, same as the other migration
-- files.
--
-- 2026-08-26 audit finding: team-invite.js's seat cap enforcement was a
-- classic TOCTOU -- it read the current seat count, checked it against the
-- plan's limit, then inserted, as three separate round-trips with nothing
-- serializing them. Two concurrent invite requests for the same team could
-- both read the same "seats used" count, both pass the check, and both
-- insert, pushing a team past its paid seat limit with no error and no
-- trace -- exactly the "check-then-write done in JS" anti-pattern this
-- codebase already fixed once for Apollo/TheirStack/Anthropic credit caps
-- (see scanShared.js's own comment on why those moved to a single atomic
-- RPC instead of a JS check-then-write).
--
-- Fixes it the same way: the seat count check and the insert now happen
-- inside ONE function call, serialized per-team via a transaction-scoped
-- advisory lock (pg_advisory_xact_lock) keyed on the team id -- a second
-- concurrent call for the same team blocks until the first one's
-- transaction commits (or rolls back), then re-reads the now-current
-- count. No window where two calls can both see "seat available" at once.
--
-- Two functions because the two insert shapes genuinely differ (an
-- existing Annie user is added as 'active' immediately; a brand-new email
-- is added as 'invited' and only becomes 'active' once handle_new_user()
-- activates it on signup) -- team-invite.js still owns everything that
-- ISN'T the seat-cap-plus-insert (auth, duplicate-membership checks,
-- sending the actual invite email), it just no longer does the seat count
-- and the insert as two separate, un-serialized steps.

create or replace function public.team_invite_add_active_member(
  p_team_id uuid,
  p_user_id uuid,
  p_seat_limit integer
)
returns text as $$
declare
  v_seats_used integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_team_id::text, 0));

  select count(*) into v_seats_used
  from public.team_members
  where team_id = p_team_id and status in ('active', 'invited');

  if v_seats_used >= p_seat_limit then
    return 'seat_limit_reached';
  end if;

  insert into public.team_members (team_id, user_id, role, status, activated_at)
  values (p_team_id, p_user_id, 'member', 'active', now());

  return 'ok';
end;
$$ language plpgsql security definer set search_path = public;

create or replace function public.team_invite_add_pending_member(
  p_team_id uuid,
  p_invited_email text,
  p_seat_limit integer
)
returns text as $$
declare
  v_seats_used integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_team_id::text, 0));

  select count(*) into v_seats_used
  from public.team_members
  where team_id = p_team_id and status in ('active', 'invited');

  if v_seats_used >= p_seat_limit then
    return 'seat_limit_reached';
  end if;

  insert into public.team_members (team_id, invited_email, role, status)
  values (p_team_id, p_invited_email, 'member', 'invited');

  return 'ok';
end;
$$ language plpgsql security definer set search_path = public;

-- Server-side only, same lockdown pattern as every other reservation RPC
-- in this codebase (see 2026-08-26-lock-down-per-customer-reserve-
-- functions.sql, applied the same session this was found).
revoke execute on function public.team_invite_add_active_member(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.team_invite_add_active_member(uuid, uuid, integer) to service_role;

revoke execute on function public.team_invite_add_pending_member(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.team_invite_add_pending_member(uuid, text, integer) to service_role;
