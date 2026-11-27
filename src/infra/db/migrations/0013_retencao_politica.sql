GRANT whatsapp_retencao TO CURRENT_USER;--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS anonymized_at timestamp with time zone;--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS lead_anonimizado_seq START 1;--> statement-breakpoint
GRANT USAGE ON SEQUENCE lead_anonimizado_seq TO whatsapp_retencao;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fn_aplicar_retencao(p_agora timestamp with time zone DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare
	v_corte timestamp with time zone := p_agora - interval '180 days';
	v_corte_lead timestamp with time zone := p_agora - interval '90 days';
	v_leads integer := 0;
	v_mensagens integer := 0;
	v_eventos integer := 0;
	v_llm_runs integer := 0;
	v_review_events integer := 0;
	v_outbox integer := 0;
	v_blocked_attempts integer := 0;
begin
	with alvo as (
		select l.id
		from leads l
		where l.anonymized_at is null
			and l.opt_out = false
			and l.created_at < v_corte_lead
			and not exists (
				select 1 from conversations c
				where c.lead_id = l.id and c.last_inbound_at >= v_corte_lead
			)
	)
	update leads l
	set
		phone_number = '+55999' || lpad(nextval('lead_anonimizado_seq')::text, 9, '0'),
		wa_jid = null,
		lid = null,
		name = null,
		address_line = null,
		anonymized_at = p_agora
	from alvo
	where l.id = alvo.id;
	get diagnostics v_leads = row_count;

	with alvo as (
		select m.id
		from messages m
		join conversations c on c.id = m.conversation_id
		where c.state = 'encerrado'
			and coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	delete from outbox o
	using alvo
	where o.message_id = alvo.id;
	get diagnostics v_outbox = row_count;

	with alvo as (
		select m.id
		from messages m
		join conversations c on c.id = m.conversation_id
		where c.state = 'encerrado'
			and coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	delete from llm_runs lr
	using alvo
	where lr.message_id = alvo.id;
	get diagnostics v_llm_runs = row_count;

	with alvo as (
		select m.id
		from messages m
		join conversations c on c.id = m.conversation_id
		where c.state = 'encerrado'
			and coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	delete from review_events re
	using alvo
	where re.message_id = alvo.id;
	get diagnostics v_review_events = row_count;

	with alvo as (
		select m.id
		from messages m
		join conversations c on c.id = m.conversation_id
		where c.state = 'encerrado'
			and coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	delete from messages m
	using alvo
	where m.id = alvo.id;
	get diagnostics v_mensagens = row_count;

	with alvo as (
		select c.id
		from conversations c
		where c.state = 'encerrado'
			and coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	update blocked_attempts ba
	set excerpt = '[eliminado]', payload_excerpt = null, detail = null
	from alvo
	where ba.conversation_id = alvo.id;
	get diagnostics v_blocked_attempts = row_count;

	with alvo as (
		select c.id
		from conversations c
		where c.state = 'encerrado'
			and coalesce(c.closed_at, greatest(c.last_inbound_at, c.last_outbound_at, c.created_at)) < v_corte
	)
	delete from event_log el
	using alvo
	where el.conversation_id = alvo.id
		and el.event_type not in ('erasure_request', 'retencao_aplicada')
		and el.created_at < v_corte;
	get diagnostics v_eventos = row_count;

	insert into event_log (event_type, entity_type, payload, severity)
	values (
		'retencao_aplicada',
		'retencao',
		jsonb_build_object(
			'corte_lead', v_corte_lead,
			'corte_conversa', v_corte,
			'leades_anonimizados', v_leads,
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
		'corte_lead', v_corte_lead,
		'corte_conversa', v_corte,
		'leades_anonimizados', v_leads,
		'mensagens_eliminadas', v_mensagens,
		'eventos_eliminados', v_eventos,
		'llm_runs_eliminados', v_llm_runs,
		'review_events_eliminados', v_review_events,
		'outbox_eliminado', v_outbox,
		'blocked_attempts_reduzidos', v_blocked_attempts
	);
end;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION fn_aplicar_erasure(
	p_lead_id uuid,
	p_raw_content text,
	p_ocorrido_em timestamp with time zone DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare
	v_basis text;
	v_purpose text;
	v_conversas integer := 0;
begin
	select legal_basis, purpose into v_basis, v_purpose from leads where id = p_lead_id;
	if not found then
		raise exception 'lead % nao encontrado', p_lead_id;
	end if;

	update leads
	set
		opt_out = true,
		name = null,
		address_line = null,
		wa_jid = null,
		lid = null,
		anonymized_at = p_ocorrido_em
	where id = p_lead_id;

	update conversations
	set state = 'encerrado', closed_reason = 'opt_out'
	where lead_id = p_lead_id and state <> 'encerrado';
	get diagnostics v_conversas = row_count;

	insert into optout_ledger (
		lead_id, event_type, source, detected_by, raw_content,
		legal_basis, purpose, occurred_at
	)
	values (
		p_lead_id, 'erasure_request', 'manual', null, left(p_raw_content, 200),
		v_basis, v_purpose, p_ocorrido_em
	);

	insert into event_log (event_type, entity_type, entity_id, lead_id, payload, severity)
	values (
		'erasure_request', 'lead', p_lead_id, p_lead_id,
		jsonb_build_object(
			'conversas_encerradas', v_conversas,
			'campos_anonimizados', jsonb_build_array('name', 'address_line', 'wa_jid', 'lid'),
			'ocorrido_em', p_ocorrido_em
		),
		'info'
	);

	return jsonb_build_object(
		'lead_id', p_lead_id,
		'conversas_encerradas', v_conversas,
		'campos_anonimizados', jsonb_build_array('name', 'address_line', 'wa_jid', 'lid')
	);
end;
$$;--> statement-breakpoint
COMMENT ON FUNCTION fn_aplicar_retencao(timestamp with time zone) is 'Aplica 90 dias de anonimização de leads (LEAD-04: linha permanece com origem/base/finalidade) e 180 dias de destruição de payload de conversas encerradas. Somente o papel whatsapp_retencao, via SECURITY DEFINER, pode usar a exceção append-only.';--> statement-breakpoint
REVOKE whatsapp_retencao FROM CURRENT_USER;
