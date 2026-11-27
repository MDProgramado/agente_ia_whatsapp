CREATE OR REPLACE FUNCTION fn_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
	if TG_OP = 'DELETE'
		and TG_TABLE_NAME in ('messages', 'event_log', 'llm_runs', 'review_events')
		and coalesce(current_setting('app.retencao_autorizada', true), 'off') = 'on' then
		return old;
	end if;
	raise exception 'tabela % e append-only (R-043): % proibido', TG_TABLE_NAME, TG_OP;
	return null;
end;
$$;--> statement-breakpoint
COMMENT ON FUNCTION fn_append_only() is 'BEFORE UPDATE OR DELETE. Sustenta R-043 (historico imutavel) e COMP-02. A unica excecao e DELETE das tabelas de prazo expirado, feito por fn_aplicar_retencao com app.retencao_autorizada=on.';--> statement-breakpoint
CREATE OR REPLACE FUNCTION fn_aplicar_retencao(p_agora timestamp with time zone DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare
	v_corte timestamp with time zone := p_agora - interval '180 days';
	v_mensagens integer := 0;
	v_eventos integer := 0;
	v_llm_runs integer := 0;
	v_review_events integer := 0;
	v_outbox integer := 0;
	v_blocked_attempts integer := 0;
begin
	perform set_config('app.retencao_autorizada', 'on', true);

	with alvo as (
		select m.id
		from messages m
		join conversations c on c.id = m.conversation_id
		where coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	delete from outbox o
	using alvo
	where o.message_id = alvo.id;
	get diagnostics v_outbox = row_count;

	with alvo as (
		select m.id
		from messages m
		join conversations c on c.id = m.conversation_id
		where coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	delete from llm_runs lr
	using alvo
	where lr.message_id = alvo.id;
	get diagnostics v_llm_runs = row_count;

	with alvo as (
		select m.id
		from messages m
		join conversations c on c.id = m.conversation_id
		where coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	delete from review_events re
	using alvo
	where re.message_id = alvo.id;
	get diagnostics v_review_events = row_count;

	with alvo as (
		select m.id
		from messages m
		join conversations c on c.id = m.conversation_id
		where coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	delete from messages m
	using alvo
	where m.id = alvo.id;
	get diagnostics v_mensagens = row_count;

	with alvo as (
		select c.id
		from conversations c
		where coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	update blocked_attempts ba
	set excerpt = '[eliminado]', payload_excerpt = null, detail = null
	from alvo
	where ba.conversation_id = alvo.id;
	get diagnostics v_blocked_attempts = row_count;

	with alvo as (
		select c.id
		from conversations c
		where coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	delete from event_log el
	using alvo
	where el.conversation_id = alvo.id
		and el.event_type not in ('erasure_request', 'retencao_aplicada')
		and el.created_at < v_corte;
	get diagnostics v_eventos = row_count;

	perform set_config('app.retencao_autorizada', 'off', true);

	insert into event_log (event_type, entity_type, payload, severity)
	values (
		'retencao_aplicada',
		'retencao',
		jsonb_build_object(
			'corte', v_corte,
			'mensagens_eliminadas', v_mensagens,
			'eventos_eliminados', v_eventos,
			'llm_runs_eliminados', v_llm_runs,
			'review_events_eliminados', v_review_events,
			'outbox_eliminado', v_outbox,
			'blocked_attempts_reduzidos', v_blocked_attempts
		),
		'info'
	);

	return jsonb_build_object(
		'corte', v_corte,
		'mensagens_eliminadas', v_mensagens,
		'eventos_eliminados', v_eventos,
		'llm_runs_eliminados', v_llm_runs,
		'review_events_eliminados', v_review_events,
		'outbox_eliminado', v_outbox,
		'blocked_attempts_reduzidos', v_blocked_attempts
	);
end;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_aplicar_retencao(timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION fn_aplicar_retencao(timestamp with time zone) TO %I', current_user); END $$;
