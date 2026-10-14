CREATE TABLE "capacity_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"entry_type" text NOT NULL,
	"reservation_id" uuid,
	"delta_reserved_minor" bigint DEFAULT 0 NOT NULL,
	"delta_credit_limit_minor" bigint DEFAULT 0 NOT NULL,
	"reserved_after_minor" bigint NOT NULL,
	"credit_limit_after_minor" bigint NOT NULL,
	"source" text NOT NULL,
	"actor" text,
	"correlation_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"base_currency" char(3) NOT NULL,
	"quote_currency" char(3) NOT NULL,
	"rate" numeric(30, 12) NOT NULL,
	"as_of" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_base_currency_quote_currency_pk" PRIMARY KEY("base_currency","quote_currency"),
	CONSTRAINT "fx_rates_rate_positive" CHECK ("fx_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"partition" integer NOT NULL,
	"offset" text NOT NULL,
	"message_type" text NOT NULL,
	"processed_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp (3) with time zone,
	CONSTRAINT "outbox_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" text PRIMARY KEY NOT NULL,
	"currency" char(3) NOT NULL,
	"credit_limit_minor" bigint NOT NULL,
	"reserved_minor" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"treasury_sequence" bigint DEFAULT 0 NOT NULL,
	"last_reconciled_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programs_credit_limit_non_negative" CHECK ("programs"."credit_limit_minor" >= 0),
	CONSTRAINT "programs_reserved_non_negative" CHECK ("programs"."reserved_minor" >= 0),
	CONSTRAINT "programs_status_valid" CHECK ("programs"."status" in ('ACTIVE', 'SUSPENDED'))
);
--> statement-breakpoint
CREATE TABLE "reservation_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" text NOT NULL,
	"reservation_id" uuid NOT NULL,
	"release_id" text NOT NULL,
	"invoice_amount_minor" bigint NOT NULL,
	"program_amount_minor" bigint NOT NULL,
	"source" text NOT NULL,
	"created_by" text,
	"correlation_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_releases_amounts_valid" CHECK ("reservation_releases"."invoice_amount_minor" >= 0 and "reservation_releases"."program_amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"program_currency" char(3) NOT NULL,
	"invoice_currency" char(3) NOT NULL,
	"invoice_amount_minor" bigint NOT NULL,
	"fx_rate" numeric(30, 12),
	"fx_rate_as_of" timestamp (3) with time zone,
	"reserved_minor" bigint NOT NULL,
	"released_minor" bigint DEFAULT 0 NOT NULL,
	"released_invoice_minor" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"discrepancy" boolean DEFAULT false NOT NULL,
	"api_modified_at" timestamp (3) with time zone,
	"created_by" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_invoice_amount_positive" CHECK ("reservations"."invoice_amount_minor" > 0),
	CONSTRAINT "reservations_reserved_non_negative" CHECK ("reservations"."reserved_minor" >= 0),
	CONSTRAINT "reservations_released_within_reserved" CHECK ("reservations"."released_minor" >= 0 and "reservations"."released_minor" <= "reservations"."reserved_minor"),
	CONSTRAINT "reservations_released_invoice_within_amount" CHECK ("reservations"."released_invoice_minor" >= 0 and "reservations"."released_invoice_minor" <= "reservations"."invoice_amount_minor"),
	CONSTRAINT "reservations_status_valid" CHECK ("reservations"."status" in ('ACTIVE', 'RELEASED')),
	CONSTRAINT "reservations_source_valid" CHECK ("reservations"."source" in ('API', 'TREASURY'))
);
--> statement-breakpoint
ALTER TABLE "capacity_ledger" ADD CONSTRAINT "capacity_ledger_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_ledger" ADD CONSTRAINT "capacity_ledger_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_releases" ADD CONSTRAINT "reservation_releases_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_releases" ADD CONSTRAINT "reservation_releases_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capacity_ledger_program_idx" ON "capacity_ledger" USING btree ("program_id","id");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("id") WHERE "outbox_events"."published_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_releases_program_release_uq" ON "reservation_releases" USING btree ("program_id","release_id");--> statement-breakpoint
CREATE INDEX "reservation_releases_reservation_idx" ON "reservation_releases" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_program_invoice_uq" ON "reservations" USING btree ("program_id","invoice_id");--> statement-breakpoint
CREATE INDEX "reservations_program_status_idx" ON "reservations" USING btree ("program_id","status");--> statement-breakpoint
CREATE INDEX "reservations_program_created_idx" ON "reservations" USING btree ("program_id","created_at","id");