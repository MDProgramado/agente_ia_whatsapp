ALTER TABLE "conversations" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "trg_conversations_closed_at_fn"() RETURNS trigger AS $$ BEGIN IF NEW.state = 'encerrado' AND OLD.state <> 'encerrado' THEN NEW.closed_at = now(); END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_conversations_closed_at" ON "conversations";--> statement-breakpoint
CREATE TRIGGER "trg_conversations_closed_at" BEFORE UPDATE OF "state" ON "conversations" FOR EACH ROW EXECUTE FUNCTION "trg_conversations_closed_at_fn"();--> statement-breakpoint
UPDATE "conversations" SET "closed_at" = GREATEST("last_inbound_at", "last_outbound_at", "created_at") WHERE state = 'encerrado' AND closed_at IS NULL;
