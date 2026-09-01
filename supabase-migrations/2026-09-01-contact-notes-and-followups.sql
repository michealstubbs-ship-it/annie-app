-- Contact detail view: an accumulating notes log + a follow-up reminder.
--
-- Michael's own description of what he wants: "once you type in there, it
-- should save to that contact's name, with the notes and the date. Then
-- next time, when you open it up, it has the previous notes, but now
-- there is a new empty one." That's an append-only log, not the single
-- overwrite-on-save `contacts.notes text` field every entity in this app
-- already has (contacts, companies, candidates, jobs, deals, meetings,
-- bd_tasks all just have one `notes text` column, confirmed by a full
-- grep before writing this — there is no existing accumulating-notes
-- precedent anywhere to extend, this is genuinely new). `contacts.notes`
-- itself is untouched by this migration; it stays exactly what
-- ContactFormModal already uses it for.
--
-- Same reasoning applies to meetings' Outcome/Next steps fields (Michael:
-- "that should be the same as point 2, saves as a note next to that
-- contact") — those get appended into this same table from the
-- application layer (src/lib/data/meetings.js), not a new schema concept.

create table if not exists public.contact_notes (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid references public.teams(id),
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.contact_notes enable row level security;

create index if not exists contact_notes_contact_id_idx on public.contact_notes(contact_id, created_at desc);
create index if not exists contact_notes_user_id_idx on public.contact_notes(user_id);
create index if not exists contact_notes_team_id_idx on public.contact_notes(team_id);

-- Same team-shared-CRM shape as contacts/deals/candidates/meetings
-- (2026-08-24-teams-and-shared-crm.sql) — a team member can read/write
-- notes on any contact their team owns, not just ones they personally
-- created; falls back to per-user ownership if team_id somehow never got
-- filled in (same defensive fallback that migration used).
create policy "contact_notes_all_own" on public.contact_notes
  for all using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  )
  with check (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

drop trigger if exists trg_fill_team_id on public.contact_notes;
create trigger trg_fill_team_id before insert on public.contact_notes
  for each row execute function public.fill_team_id();

-- Follow-up reminder: same `date` + a reason, living directly on the
-- contact (matches candidates.follow_up_date / meetings.follow_up_date's
-- existing plain-date convention — no time-of-day anywhere else in this
-- schema for a follow-up, so not introducing one here either).
alter table public.contacts add column if not exists follow_up_date date;
alter table public.contacts add column if not exists follow_up_reason text;

create index if not exists contacts_follow_up_date_idx on public.contacts(follow_up_date) where follow_up_date is not null;
