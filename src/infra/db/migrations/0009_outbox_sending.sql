ALTER TABLE "outbox" DROP CONSTRAINT "outbox_status_check";--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_status_check" CHECK (status IN ('pending', 'reserved', 'sending', 'sent', 'failed', 'abandoned'));
