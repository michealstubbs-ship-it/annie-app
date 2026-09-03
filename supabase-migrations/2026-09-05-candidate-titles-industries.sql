-- Michael, in a run of follow-ups on item 3 (the CV-first candidate form):
-- "I think it is important that she adds multiple industries and different
-- titles for that one CV... it is important... this will help her to
-- recommend relevant candidates to live jobs that may come up" — clarified
-- later that this means AI-inferred TITLE EQUIVALENCE (different wording
-- for the same real role a candidate's actual experience supports), not a
-- literal transcription of every job title in their career history.
--
-- `candidates.role` and `candidates.industry` stay exactly as they are —
-- singular, free-text, the one value shown as the headline on a candidate's
-- card. These two new columns are additive: the FULL SET of titles/
-- industries Annie's CV parse thinks this candidate is realistically a
-- match for, used only by the matching logic (candidateMatch.js) that scores
-- candidates against a job brief or a live_job signal — never overwriting
-- what the recruiter sees as "their" role/industry on the card itself.
--
-- jsonb array of plain strings, defaulting to an empty array (never null)
-- so every existing row and every matching-logic caller can treat this as
-- "zero or more strings" without a null check.
alter table public.candidates add column if not exists titles jsonb not null default '[]'::jsonb;
alter table public.candidates add column if not exists industries jsonb not null default '[]'::jsonb;

comment on column public.candidates.titles is 'AI-inferred set of equivalent job titles this candidate''s real experience supports (e.g. "Head of Growth" also matching "VP Marketing", "Growth Lead") — additive to the singular, recruiter-facing `role` field, used only for matching against jobs/live_job signals.';
comment on column public.candidates.industries is 'AI-inferred set of industries this candidate''s real experience is relevant to — additive to the singular, recruiter-facing `industry` field, used only for matching against jobs/live_job signals.';
