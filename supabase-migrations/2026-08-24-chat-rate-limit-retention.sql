-- Task 3 performance pass (2026-08-24) found chat_rate_limit
-- (2026-08-22-anthropic-cost-cap-and-chat-rate-limit.sql) was missed by the
-- data-retention sweep that same week: it accumulates one row per
-- (user_id, minute_bucket) for every minute any user calls chat.js, forever
-- — a worse growth rate than any of the four tables the original retention
-- job already covers, since it's keyed per-minute rather than per-signal or
-- per-message. Nothing ever reads a bucket after chat_reserve_call's own
-- request finishes with it, so unlike the 18-month retention used for
-- intelligence_signals/chat_messages/support_messages/error_logs (real
-- historical data with product value), this table only needs to keep the
-- last day or two of buckets — old ones are pure dead weight.
--
-- Same batched-delete pattern as the other four cleanup functions, same
-- SECURITY DEFINER + service_role-only convention.

-- The existing primary key (user_id, minute_bucket) doesn't help a
-- table-wide "older than N" scan since minute_bucket isn't the leading
-- column — same reasoning as the dedicated indexes added in
-- 2026-08-22-data-retention.sql for the other three tables.
CREATE INDEX IF NOT EXISTS chat_rate_limit_minute_bucket_idx ON public.chat_rate_limit (minute_bucket);

CREATE OR REPLACE FUNCTION public.retention_cleanup_chat_rate_limit(
  p_cutoff timestamptz, p_batch_size integer DEFAULT 5000, p_max_batches integer DEFAULT 200
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total_deleted integer := 0;
  rows_deleted integer;
  batches integer := 0;
BEGIN
  LOOP
    DELETE FROM public.chat_rate_limit
    WHERE (user_id, minute_bucket) IN (
      SELECT user_id, minute_bucket FROM public.chat_rate_limit WHERE minute_bucket < p_cutoff LIMIT p_batch_size
    );
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    total_deleted := total_deleted + rows_deleted;
    batches := batches + 1;
    EXIT WHEN rows_deleted = 0 OR batches >= p_max_batches;
  END LOOP;
  RETURN total_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.retention_cleanup_chat_rate_limit(timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retention_cleanup_chat_rate_limit(timestamptz, integer, integer) TO service_role;
