CREATE TABLE "cards" (
	"id" text PRIMARY KEY,
	"text" text NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"tag" text DEFAULT 'своё' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
