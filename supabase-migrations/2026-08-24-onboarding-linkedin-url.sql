-- LinkedIn profile URL, collected at onboarding step 1 alongside firm name
-- (mirrors the field already shown in the marketing site's own onboarding
-- preview at meetannie.ai). Additive, nullable — existing rows are
-- unaffected.
alter table public.onboarding add column if not exists linkedin_url text;
