-- Anthropic token accounting reconciled against what Anthropic actually
-- billed, rather than left at the worst-case reservation.
--
-- anthropic_reserve_tokens books `max_tokens` before the call, because that
-- is the only number known up front. Nothing ever corrected it afterwards,
-- so anthropic_usage recorded three separate errors at once:
--
--   1. Output over-counted. Chat.jsx sends maxTokens 1500; measured real
--      output on production was ~485 tokens per message.
--   2. Input counted as ZERO. The system prompt, the CRM snapshot, the
--      capped history and every web-search result block are all billed
--      input and none of them were metered at all.
--   3. Web search tool uses (up to 6 per message) metered as zero.
--
-- Net effect: the per-customer daily token cap was enforced against a
-- number only loosely correlated with the bill — over on short questions,
-- badly under on search-heavy ones.
--
-- This applies the signed difference between what was reserved and what
-- Anthropic reported in usage.input_tokens + usage.output_tokens. The delta
-- is normally negative (we reserved more than we spent) but is positive
-- whenever input dominated, which is exactly the case that was invisible.
create or replace function public.anthropic_reconcile_tokens(
  p_reserved integer,
  p_actual integer,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_delta integer;
begin
  if p_reserved is null or p_actual is null then
    return;
  end if;

  v_delta := p_actual - p_reserved;
  if v_delta = 0 then
    return;
  end if;

  if p_user_id is not null then
    update public.anthropic_usage
    set tokens_used = greatest(0, tokens_used + v_delta)
    where day = current_date and user_id = p_user_id;
  end if;

  update public.anthropic_usage_platform
  set tokens_used = greatest(0, tokens_used + v_delta)
  where day = current_date;
end;
$function$;

revoke all on function public.anthropic_reconcile_tokens(integer, integer, uuid) from public;
grant execute on function public.anthropic_reconcile_tokens(integer, integer, uuid) to service_role;
