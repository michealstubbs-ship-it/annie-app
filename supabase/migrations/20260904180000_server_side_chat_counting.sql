-- Server-side Ask Annie counting. Applied to production 2026-09-04.
--
-- The monthly cap used to be enforced by COUNTING ROWS IN chat_messages, and
-- chat_messages is written by the browser (Chat.jsx), never by /api/chat. So
-- the counter only moved when someone used the website. Any other caller — a
-- script, curl, anything holding a valid session token — had unlimited Ask
-- Annie on a Starter plan, on Anthropic's bill, while the dashboard showed
-- them at zero. It also made the cap untestable: four days of snag-week
-- conversation recorded nothing, because none of it went through a browser.
--
-- This table is the counter, deliberately separate from the transcript. A
-- transcript is a product feature the customer can delete from; a usage counter
-- is a billing artefact that must not move when they do.

create table if not exists public.chat_monthly_usage (
  month date not null,
  user_id uuid not null,
  messages_used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (month, user_id)
);

alter table public.chat_monthly_usage enable row level security;
drop policy if exists chat_monthly_usage_select_own on public.chat_monthly_usage;
create policy chat_monthly_usage_select_own on public.chat_monthly_usage for select
  using (user_id = auth.uid());

-- Read without moving it: the pre-call cap check, so someone at their ceiling
-- is refused before anything is spent at Anthropic.
create or replace function public.chat_usage_this_month(p_user_id uuid)
returns integer language sql security definer set search_path to 'public' as $function$
  select coalesce((select messages_used from public.chat_monthly_usage
    where user_id = p_user_id and month = date_trunc('month', current_date)::date), 0);
$function$;

-- Incremented once per accepted Anthropic reply, on the server, so it counts
-- every caller rather than only the website.
create or replace function public.chat_usage_increment(p_user_id uuid)
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare v_total integer;
begin
  if p_user_id is null then return null; end if;
  insert into public.chat_monthly_usage (month, user_id, messages_used)
  values (date_trunc('month', current_date)::date, p_user_id, 1)
  on conflict (month, user_id)
  do update set messages_used = chat_monthly_usage.messages_used + 1, updated_at = now()
  returning messages_used into v_total;
  return v_total;
end;
$function$;

revoke all on function public.chat_usage_increment(uuid) from public;
grant execute on function public.chat_usage_increment(uuid) to service_role;
grant execute on function public.chat_usage_this_month(uuid) to service_role, authenticated;

-- Backfill from the transcript so nobody's allowance silently resets to zero on
-- deploy day. It only ever captured browser traffic, but it is the best record
-- of what has actually been sent.
insert into public.chat_monthly_usage (month, user_id, messages_used)
select date_trunc('month', created_at)::date, user_id, count(*)
from public.chat_messages
where role = 'user' and created_at >= date_trunc('month', current_date)
group by 1, 2
on conflict (month, user_id) do nothing;
