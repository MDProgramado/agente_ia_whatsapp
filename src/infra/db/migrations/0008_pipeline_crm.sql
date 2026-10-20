CREATE TABLE "lead_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"conversation_id" uuid,
	"body" text NOT NULL,
	"author_type" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_notes_author_type_check" CHECK (author_type IN ('admin', 'ia'))
);
--> statement-breakpoint
CREATE TABLE "lead_tags" (
	"lead_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_tags_pkey" PRIMARY KEY("lead_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"responsible_user_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_status_check" CHECK (status IN ('pending', 'done', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "pipeline_status" text DEFAULT 'novo' NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_responsible_user_id_app_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_notes_lead_created_idx" ON "lead_notes" USING btree ("lead_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "lead_tags_tag_idx" ON "lead_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tags_name_idx" ON "tags" USING btree ("name");--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("due_at","status");--> statement-breakpoint
CREATE INDEX "tasks_lead_idx" ON "tasks" USING btree ("lead_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_pipeline_status_check" CHECK (pipeline_status IN ('novo', 'contatado', 'respondeu', 'qualificado', 'aquecido', 'reuniao_agendada', 'proposta', 'fechado', 'perdido'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_closed_reason_check" CHECK (closed_reason IS NULL OR closed_reason IN ('sem_resposta', 'sem_interesse', 'sem_verba', 'sem_decisao', 'concorrente', 'fora_do_perfil', 'opt_out', 'bad_timing', 'outro'));--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Parte MANUAL desta migration (escrito à mão, acima do bloco gerado pelo
-- drizzle-kit): COMMENTs, BACKFILL da base viva, verificação pós-migração e
-- guardas de append-only. Rodar `drizzle-kit generate` de novo NÃO sobrescreve
-- esta parte — ele só cria migration nova se o `schema.ts` mudar.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE "tags" IS
	'Etiquetas de lead (D-22, R-048). name UNIQUE: tag duplicada viraria filtro ambiguo no painel.';--> statement-breakpoint
COMMENT ON TABLE "lead_tags" IS
	'Juncao N:N lead x tag (D-22). PK composta = idempotencia: associar duas vezes viola a PK, nao duplica vinculo.';--> statement-breakpoint
COMMENT ON TABLE "lead_notes" IS
	'Notas do lead do Admin e notas AUTOMATICAS da IA (D-22, CRM-03, R-043). author_type CHECK (''admin''|''ia'') distingue as duas (T-03-37). APPEND-ONLY: trigger trg_lead_notes_append_only + REVOKE.';--> statement-breakpoint
COMMENT ON TABLE "tasks" IS
	'Tarefas e lembretes do lead (D-22). due_at/status/responsible_user_id nullable; R-028 nasce aqui. Duas tabelas viraram uma porque a pergunta do painel e a mesma: o que fazer com este lead ate quando.';--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- BACKFILL da base viva (Pitfall 7, T-03-31): toda conversa existente sai desta
-- migration com pipeline_status classificado a partir de `state` (FSM do motor)
-- e de `messages` — nunca em 'novo' quando a conversa já teve atividade.
--
-- MAPA EXPLÍCITO state -> pipeline_status (D-14; conservador: nunca afirma
-- progresso que a conversa não mostra; o Admin corrige pelo CRM, e toda
-- correção gera nova linha em status_history):
--
--   leads.opt_out = true      -> 'perdido'  (D-16: opt_out é terminal)
--   state = 'encerrado'       -> 'perdido'  (D-13: cadência encerrada = PERDIDO)
--   state = 'aquecido'        -> 'aquecido' (mesmo domínio, qualificação concluída)
--   state em (awaiting_human, human, copilot) -> 'qualificado' (handoff: humano assumiu)
--   state = 'qualificando'    -> 'respondeu' (dialogando, ainda sendo qualificado)
--   tem inbound em messages   -> 'respondeu' (Pitfall 7: lead já respondeu)
--   state = 'aquecimento'     -> 'contatado' (1º contato humano já saiu, R-001)
--   tem outbound em messages  -> 'contatado'
--   resto                     -> 'novo'
--
-- IDEMPOTENTE por `WHERE pipeline_status = 'novo'` (a coluna nasce 'novo' nesta
-- migration; re-executar o bloco não reclassifica quem já foi classificado).
-- `messages` e `status_history` são APPEND-ONLY: este bloco LÊ `messages` e
-- INSERTA em `status_history` — nunca escreve UPDATE/DELETE em nenhum dos dois.
with reclass as (
	update conversations c
	set pipeline_status = case
			when exists (select 1 from leads l where l.id = c.lead_id and l.opt_out)
				then 'perdido'
			when c.state = 'encerrado' then 'perdido'
			when c.state = 'aquecido' then 'aquecido'
			when c.state in ('awaiting_human', 'human', 'copilot') then 'qualificado'
			when c.state = 'qualificando' then 'respondeu'
			when exists (select 1 from messages m
					where m.conversation_id = c.id and m.direction = 'in')
				then 'respondeu'
			when c.state = 'aquecimento' then 'contatado'
			when exists (select 1 from messages m
					where m.conversation_id = c.id and m.direction = 'out')
				then 'contatado'
			else 'novo'
		end
	where c.pipeline_status = 'novo'
		and (
			c.state <> 'novo'
			or exists (select 1 from leads l where l.id = c.lead_id and l.opt_out)
			or exists (select 1 from messages m
				where m.conversation_id = c.id and m.direction = 'in')
		)
	returning c.id, c.pipeline_status
)
insert into status_history (conversation_id, from_state, to_state, changed_by, reason)
select id, 'novo', pipeline_status, 'system', 'backfill_0008: pipeline derivado de state/messages'
from reclass
where pipeline_status <> 'novo';--> statement-breakpoint
-- D-15/RN-082: Perdido exige motivo. Preenche o que o backfill marcou como
-- 'perdido' (e o state 'encerrado' do catchup) sem motivo ainda registrado.
-- `opt_out` ganha o motivo 'opt_out' (D-16) e nunca 'sem_resposta'.
update conversations c
set closed_reason = case
		when exists (select 1 from leads l where l.id = c.lead_id and l.opt_out)
			then 'opt_out'
		else 'sem_resposta'
	end
where c.closed_reason is null
	and (c.state = 'encerrado'
		or exists (select 1 from leads l where l.id = c.lead_id and l.opt_out));--> statement-breakpoint
-- VERIFICAÇÃO PÓS-MIGRAÇÃO (T-03-31, Pitfall 7): falhar o boot é de propósito —
-- migration meio aplicada é pior que boot abortado. A não-nulidade já é imposta
-- pelo `NOT NULL DEFAULT 'novo'` acima; o que se verifica aqui é COBERTURA do
-- backfill: nenhuma conversa com lead já respondendo pode ter ficado em 'novo'.
do $verifica$
begin
	if exists (
		select 1 from conversations c
		where c.pipeline_status = 'novo'
			and exists (select 1 from messages m
				where m.conversation_id = c.id and m.direction = 'in')
	) then
		raise exception 'backfill_0008: conversa com inbound ainda em pipeline_status=novo (Pitfall 7 - classificacao perdida)';
	end if;
	if exists (select 1 from conversations where pipeline_status is null) then
		raise exception 'backfill_0008: pipeline_status nulo apos migracao (T-03-31)';
	end if;
end
$verifica$;--> statement-breakpoint
-- APPEND-ONLY do histórico de status (D-14/R-043, T-03-30): a 0004 criou a
-- tabela sem guarda e o plano 02-02 deixou por convenção da aplicação; com o
-- pipeline de CRM gravando aqui toda transição, a barreira passa a ser de
-- banco. Reusa `fn_append_only()` da 0004 — não criar segunda função.
CREATE TRIGGER trg_status_history_append_only
	before update or delete on status_history
	for each row execute function fn_append_only();--> statement-breakpoint
-- Nota do lead também é histórico (D-22 "append-only"): uma nota não se corrige,
-- se rebatiza como nova linha. Mesmo par trigger + REVOKE da 0006 (llm_runs).
CREATE TRIGGER trg_lead_notes_append_only
	before update or delete on lead_notes
	for each row execute function fn_append_only();--> statement-breakpoint
REVOKE UPDATE, DELETE ON status_history FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE ON lead_notes FROM PUBLIC;