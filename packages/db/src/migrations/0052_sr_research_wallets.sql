-- Signal research #353: tập ví nghiên cứu (top-K leaderboard) theo phiên bản cho H1 context-v2; snapshot ghi version và số ví
-- của tập đã dùng. Dòng context-v1 giữ nguyên (cột mới null).
CREATE TABLE "research_wallet_set_members" (
	"set_version" integer NOT NULL,
	"address" text NOT NULL,
	"rank" integer NOT NULL,
	CONSTRAINT "research_wallet_set_members_set_version_address_pk" PRIMARY KEY("set_version","address")
);
--> statement-breakpoint
CREATE TABLE "research_wallet_sets" (
	"version" integer PRIMARY KEY NOT NULL,
	"run_date" date NOT NULL,
	"k" integer NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD COLUMN "h1_wallet_set_version" integer;--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD COLUMN "h1_wallet_set_size" integer;--> statement-breakpoint
ALTER TABLE "research_wallet_set_members" ADD CONSTRAINT "research_wallet_set_members_set_version_research_wallet_sets_version_fk" FOREIGN KEY ("set_version") REFERENCES "public"."research_wallet_sets"("version") ON DELETE no action ON UPDATE no action;