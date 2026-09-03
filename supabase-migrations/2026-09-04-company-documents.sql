-- Michael: "Should be able to attach a document next to a client. Ie, if
-- you sign a contract with the client, you can attach it to their name" —
-- confirmed with him this means the Company record (a contract is usually
-- with the organization, not whichever contact happened to sign it).
--
-- A company can have more than one document over time (a contract, a
-- renewal, an amended agreement), so this is its own child table rather
-- than a single-file column on companies — same shape as company_contacts
-- being its own table rather than a column on companies, for the same
-- one-to-many reason. RLS mirrors invoice_line_items' own established
-- convention exactly (a child row's access is decided by walking back to
-- its parent's team_id, not by duplicating companies' own team_id/user_id
-- OR-logic a second time).
create table if not exists public.company_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null,
  file_name text not null,
  file_path text not null,
  uploaded_at timestamptz not null default now()
);

create index if not exists company_documents_company_id_idx on public.company_documents (company_id);

alter table public.company_documents enable row level security;

drop policy if exists company_documents_via_company on public.company_documents;
create policy company_documents_via_company
  on public.company_documents
  for all
  using (
    company_id in (
      select id from public.companies
      where (team_id is not null and team_id in (
              select team_id from public.team_members
              where user_id = auth.uid() and status = 'active'
            ))
         or (team_id is null and user_id = auth.uid())
    )
  )
  with check (
    company_id in (
      select id from public.companies
      where (team_id is not null and team_id in (
              select team_id from public.team_members
              where user_id = auth.uid() and status = 'active'
            ))
         or (team_id is null and user_id = auth.uid())
    )
  );

-- Storage: a new private bucket, same per-uploading-user-folder RLS
-- pattern as the existing candidate-cvs bucket (see
-- 2026-08-22-reconcile-undocumented-live-indexes-and-storage-rls.sql) —
-- downloads go through createSignedUrl (time-limited), never a public URL.
insert into storage.buckets (id, name, public)
values ('company-documents', 'company-documents', false)
on conflict (id) do nothing;

drop policy if exists company_documents_select_own on storage.objects;
create policy company_documents_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'company-documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists company_documents_insert_own on storage.objects;
create policy company_documents_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'company-documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists company_documents_update_own on storage.objects;
create policy company_documents_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'company-documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists company_documents_delete_own on storage.objects;
create policy company_documents_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'company-documents' and (storage.foldername(name))[1] = auth.uid()::text);
