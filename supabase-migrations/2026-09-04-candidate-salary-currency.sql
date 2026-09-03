-- Michael: "Need to be able to change the currency on Current salary and
-- desired salary when adding a candidate". curr_sal/want_sal were bare
-- integers with no currency of their own — the form only ever showed
-- whichever currency the FIRM's own market/invoicing default happened to
-- resolve to (see useMarketCurrency.js), which is wrong the moment a firm
-- places across more than one market (a candidate quoting an AED salary
-- for a Dubai role should still read as AED even if the firm's own default
-- is GBP). Additive, nullable columns — a candidate row saved before this
-- migration simply reads back null here, and Candidates.jsx falls back to
-- the firm's own market currency for those, same behaviour as today.
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS curr_sal_currency text;
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS want_sal_currency text;
