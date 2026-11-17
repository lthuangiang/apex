CREATE TABLE "sodex_calls_ok" (
	"id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"service" text NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"endpoint" text NOT NULL,
	"url" text,
	"engine" text,
	"action_type" text,
	"outcome" text NOT NULL,
	"http_status" smallint,
	"sodex_code" integer,
	"sodex_error" text,
	"envelope_code" integer,
	"order_codes" integer[] DEFAULT '{}' NOT NULL,
	"unreadable_reason" text,
	"error_detail" text,
	"latency_ms" integer NOT NULL,
	"request_headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_body" text,
	"request_body_bytes" integer,
	"signed" boolean DEFAULT false NOT NULL,
	"response_headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response_body" text,
	"response_body_bytes" integer,
	"response_truncated" boolean DEFAULT false NOT NULL,
	"bot_id" uuid,
	"account_id" uuid,
	"account_address" text,
	"sodex_account_id" text,
	"cl_ord_ids" text[] DEFAULT '{}' NOT NULL,
	"order_ids" text[] DEFAULT '{}' NOT NULL,
	"trace_id" text,
	"conn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sodex_calls_ok_id_at_pk" PRIMARY KEY("id","at")
);
--> statement-breakpoint
CREATE TABLE "sodex_calls_problem" (
	"id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"service" text NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"endpoint" text NOT NULL,
	"url" text,
	"engine" text,
	"action_type" text,
	"outcome" text NOT NULL,
	"http_status" smallint,
	"sodex_code" integer,
	"sodex_error" text,
	"envelope_code" integer,
	"order_codes" integer[] DEFAULT '{}' NOT NULL,
	"unreadable_reason" text,
	"error_detail" text,
	"latency_ms" integer NOT NULL,
	"request_headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_body" text,
	"request_body_bytes" integer,
	"signed" boolean DEFAULT false NOT NULL,
	"response_headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response_body" text,
	"response_body_bytes" integer,
	"response_truncated" boolean DEFAULT false NOT NULL,
	"bot_id" uuid,
	"account_id" uuid,
	"account_address" text,
	"sodex_account_id" text,
	"cl_ord_ids" text[] DEFAULT '{}' NOT NULL,
	"order_ids" text[] DEFAULT '{}' NOT NULL,
	"trace_id" text,
	"conn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sodex_calls_problem_id_at_pk" PRIMARY KEY("id","at")
);
--> statement-breakpoint
CREATE INDEX "sodex_calls_ok_at_idx" ON "sodex_calls_ok" USING btree ("at");--> statement-breakpoint
CREATE INDEX "sodex_calls_ok_endpoint_idx" ON "sodex_calls_ok" USING btree ("endpoint","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_ok_outcome_idx" ON "sodex_calls_ok" USING btree ("outcome","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_ok_service_idx" ON "sodex_calls_ok" USING btree ("service","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_ok_bot_idx" ON "sodex_calls_ok" USING btree ("bot_id","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_ok_account_idx" ON "sodex_calls_ok" USING btree ("account_address","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_ok_trace_idx" ON "sodex_calls_ok" USING btree ("trace_id","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_ok_conn_idx" ON "sodex_calls_ok" USING btree ("conn_id","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_ok_cl_ord_idx" ON "sodex_calls_ok" USING gin ("cl_ord_ids");--> statement-breakpoint
CREATE INDEX "sodex_calls_ok_order_ids_idx" ON "sodex_calls_ok" USING gin ("order_ids");--> statement-breakpoint
CREATE INDEX "sodex_calls_problem_at_idx" ON "sodex_calls_problem" USING btree ("at");--> statement-breakpoint
CREATE INDEX "sodex_calls_problem_endpoint_idx" ON "sodex_calls_problem" USING btree ("endpoint","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_problem_outcome_idx" ON "sodex_calls_problem" USING btree ("outcome","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_problem_service_idx" ON "sodex_calls_problem" USING btree ("service","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_problem_bot_idx" ON "sodex_calls_problem" USING btree ("bot_id","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_problem_account_idx" ON "sodex_calls_problem" USING btree ("account_address","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_problem_trace_idx" ON "sodex_calls_problem" USING btree ("trace_id","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_problem_conn_idx" ON "sodex_calls_problem" USING btree ("conn_id","at");--> statement-breakpoint
CREATE INDEX "sodex_calls_problem_cl_ord_idx" ON "sodex_calls_problem" USING gin ("cl_ord_ids");--> statement-breakpoint
CREATE INDEX "sodex_calls_problem_order_ids_idx" ON "sodex_calls_problem" USING gin ("order_ids");--> statement-breakpoint
-- SoDEX Debugger (DEC-TBD-sodex-debugger): hai hypertable theo thời hạn giữ, nén sau 1 ngày, xoá theo chunk.
SELECT create_hypertable('sodex_calls_ok', 'at', chunk_time_interval => INTERVAL '6 hours', create_default_indexes => FALSE, if_not_exists => TRUE);--> statement-breakpoint
SELECT create_hypertable('sodex_calls_problem', 'at', chunk_time_interval => INTERVAL '1 day', create_default_indexes => FALSE, if_not_exists => TRUE);--> statement-breakpoint
-- Bảng ok sống 3 ngày: không nén, để mọi index (bot, account, trace, clOrdID…) dùng được trên cả 3 ngày.
-- Bảng problem nén sau 2 ngày (review PR #217 M4): 2 ngày gần nhất tìm bằng index; cũ hơn lọc theo segmentby endpoint.
ALTER TABLE "sodex_calls_problem" SET (timescaledb.compress, timescaledb.compress_segmentby = 'endpoint', timescaledb.compress_orderby = 'at DESC, id');--> statement-breakpoint
SELECT add_compression_policy('sodex_calls_problem', INTERVAL '2 days', if_not_exists => TRUE);--> statement-breakpoint
SELECT add_retention_policy('sodex_calls_ok', INTERVAL '3 days', if_not_exists => TRUE);--> statement-breakpoint
SELECT add_retention_policy('sodex_calls_problem', INTERVAL '14 days', if_not_exists => TRUE);--> statement-breakpoint
CREATE VIEW "sodex_calls" AS SELECT * FROM "sodex_calls_ok" UNION ALL SELECT * FROM "sodex_calls_problem";
