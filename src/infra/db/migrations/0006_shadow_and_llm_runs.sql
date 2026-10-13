CREATE TABLE "llm_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"model" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"cost_usd" numeric(12, 6),
	"prompt_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"zod_parse_ok" boolean NOT NULL,
	"canary_ok" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"actor" text NOT NULL,
	"edited_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_events_decision_check" CHECK (decision IN ('approved', 'edited', 'discarded'))
);
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_engagement_mode_check";--> statement-breakpoint
ALTER TABLE "mode_changes" DROP CONSTRAINT "mode_changes_to_mode_check";--> statement-breakpoint
ALTER TABLE "mode_changes" DROP CONSTRAINT "mode_changes_from_mode_check";--> statement-breakpoint
ALTER TABLE "llm_runs" ADD CONSTRAINT "llm_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_runs_message_idx" ON "llm_runs" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "review_events_message_created_idx" ON "review_events" USING btree ("message_id","created_at");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_engagement_mode_check" CHECK (engagement_mode IN ('bot_active', 'awaiting_human', 'human', 'copilot', 'pausado', 'shadow'));--> statement-breakpoint
ALTER TABLE "mode_changes" ADD CONSTRAINT "mode_changes_to_mode_check" CHECK (to_mode IN ('bot_active', 'awaiting_human', 'human', 'copilot', 'pausado', 'shadow'));--> statement-breakpoint
ALTER TABLE "mode_changes" ADD CONSTRAINT "mode_changes_from_mode_check" CHECK (from_mode IN ('bot_active', 'awaiting_human', 'human', 'copilot', 'pausado', 'shadow'));
--> statement-breakpoint
-- ===========================================================================
-- Append-only de llm_runs e review_events (R-043, D-06, T-02-04)
-- ===========================================================================
-- Reusa `fn_append_only` da migration 0004 — NAO cria uma segunda funcao: o
-- comportamento e identico (o erro ja cita TG_TABLE_NAME) e uma funcao por
-- tabela e como a regra se fragmenta ate valer para uma so.
--
-- Dois caminhos redundantes, como em 0004: o trigger (para quem tem o
-- privilegio por outro caminho, inclusive superuser) e o `REVOKE` (negacao que
-- impede a tentativa). Um metadado de execucao (llm_runs) e um evento de
-- revisao (review_events) nao sao corrigidos — sao re-medidos/re-registrados.
DROP TRIGGER IF EXISTS trg_llm_runs_append_only on llm_runs;
CREATE TRIGGER trg_llm_runs_append_only
	before update or delete on llm_runs
	for each row execute function fn_append_only();

DROP TRIGGER IF EXISTS trg_review_events_append_only on review_events;
CREATE TRIGGER trg_review_events_append_only
	before update or delete on review_events
	for each row execute function fn_append_only();

REVOKE UPDATE, DELETE ON llm_runs FROM PUBLIC;
REVOKE UPDATE, DELETE ON review_events FROM PUBLIC;

COMMENT ON TABLE llm_runs is
	'Metadados de execucao da LLM (D-05, R-045). Append-only. Guarda modelo, tokens, latencia, custo e versoes — NUNCA o corpo do prompt/resposta (o corpo vive em messages). message_id nullable: a corrida de extracao acontece antes de existir rascunho.';

COMMENT ON TABLE review_events is
	'Decisao de revisao do rascunho em shadow (D-03/D-06): approved/edited/discarded. Append-only. E o evento que substitui o UPDATE messages.status, impossivel porque messages e imutavel (R-043).';