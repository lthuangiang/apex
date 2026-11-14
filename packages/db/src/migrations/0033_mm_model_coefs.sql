CREATE TABLE "mm_model_coefs" (
	"version" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mm_model_coefs_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"a" numeric(20, 10) NOT NULL,
	"k" numeric(20, 10) NOT NULL,
	"points" integer NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
