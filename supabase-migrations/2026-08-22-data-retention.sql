-- Applied live to the annie app project via the Supabase MCP — kept here for
-- the record, same as every other migration in this folder.
--
-- A scale-readiness audit (2026-08-22) found nothing ever deletes or
-- archives a row from intelligence_signals, chat_messages,
-- support_messages, or error_logs. At a conservative 2,000 customers
-- generating ~5 new signals per 12-hour scan, that's ~20,000 new rows a
-- day — ~7.3 million a year — permanently, with no product value once a
-- signal's outcome is already captured. This adds the retention mechanism:
-- four SECURITY DEFINER cleanup functions (one per table, rather than one
-- dynamic-SQL function taking a table name — avoids any table-name
-- interpolation entirely), each batched so a large backlog can't hold a
-- single DELETE's lock for an extended period, called by
-- netlify/functions/data-retention.js on a weekly schedule.
--
-- signal_outcomes.signal_id -> intelligence_signals.id is ON DELETE SET
-- NULL (confirmed via information_schema before writing this), so deleting
-- an old signal preserves its outcome row, just detached from the deleted
-- signal — the historical "was this ever placed" signal survives even
-- after the signal itself ages out.

-- Dedicated single-column indexes for the retention job's own WHERE clause.
-- The existing composite indexes on these tables (chat_messages_user_created_idx,
-- support_messages_user_created_idx, intelligence_signals_user_found_idx) all
-- lead with user_id, which doesn't help a table-wide "older than N" scan.
-- error_logs already has error_logs_created_at_idx from the previous audit pass.
CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx ON public.chat_messages (created_at);
CREATE INDEX IF NOT EXISTS support_messages_created_at_idx ON public.support_messages (created_at);
CREATE INDEX IF NOT EXISTS intelligence_signals_found_at_idx ON public.intelligence_signals (found_at);

CREATE OR REPLACE FUNCTION public.retention_cleanup_intelligence_signals(
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
    DELETE FROM public.intelligence_signals
    WHERE id IN (SELECT id FROM public.intelligence_signals WHERE found_at < p_cutoff LIMIT p_batch_size);
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    total_deleted := total_deleted + rows_deleted;
    batches := batches + 1;
    EXIT WHEN rows_deleted = 0 OR batches >= p_max_batches;
  END LOOP;
  RETURN total_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.retention_cleanup_chat_messages(
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
    DELETE FROM public.chat_messages
    WHERE id IN (SELECT id FROM public.chat_messages WHERE created_at < p_cutoff LIMIT p_batch_size);
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    total_deleted := total_deleted + rows_deleted;
    batches := batches + 1;
    EXIT WHEN rows_deleted = 0 OR batches >= p_max_batches;
  END LOOP;
  RETURN total_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.retention_cleanup_support_messages(
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
    DELETE FROM public.support_messages
    WHERE id IN (SELECT id FROM public.support_messages WHERE created_at < p_cutoff LIMIT p_batch_size);
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    total_deleted := total_deleted + rows_deleted;
    batches := batches + 1;
    EXIT WHEN rows_deleted = 0 OR batches >= p_max_batches;
  END LOOP;
  RETURN total_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.retention_cleanup_error_logs(
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
    DELETE FROM public.error_logs
    WHERE id IN (SELECT id FROM public.error_logs WHERE created_at < p_cutoff LIMIT p_batch_size);
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    total_deleted := total_deleted + rows_deleted;
    batches := batches + 1;
    EXIT WHEN rows_deleted = 0 OR batches >= p_max_batches;
  END LOOP;
  RETURN total_deleted;
END;
$$;

-- Server-only, same convention as every other cost-cap/cleanup RPC in this
-- codebase (apollo_reserve_credits, anthropic_reserve_tokens, etc.) — never
-- meant to be called from a user session, only from the scheduled function.
REVOKE EXECUTE ON FUNCTION public.retention_cleanup_intelligence_signals(timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.retention_cleanup_chat_messages(timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.retention_cleanup_support_messages(timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.retention_cleanup_error_logs(timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retention_cleanup_intelligence_signals(timestamptz, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_cleanup_chat_messages(timestamptz, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_cleanup_support_messages(timestamptz, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_cleanup_error_logs(timestamptz, integer, integer) TO service_role;
