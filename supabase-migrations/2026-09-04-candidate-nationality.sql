-- Michael: "for candidate, we need to add a nationality function". Additive,
-- nullable — free-text for now, same pattern as location/industry on this
-- same table. A candidate row saved before this migration simply reads
-- back null here.
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS nationality text;
