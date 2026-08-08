CREATE TABLE "availability_plans" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "time_zone" TEXT NOT NULL,
  "default_weekly_hours" REAL NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "availability_plans_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "people" ("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "availability_plans_organization_id_person_id_key" ON "availability_plans"("organization_id", "person_id");
CREATE INDEX "availability_plans_organization_id_updated_at_idx" ON "availability_plans"("organization_id", "updated_at");

CREATE TABLE "availability_entries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "plan_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "starts_on" TEXT NOT NULL,
  "ends_on" TEXT NOT NULL,
  "hours_per_week" REAL,
  "label" TEXT,
  "color" TEXT,
  "time_off_availability" TEXT,
  "private_reason" TEXT,
  "supporting_uri" TEXT,
  "visibility" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "confirmed_at" DATETIME NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "availability_entries_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "availability_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "availability_entries_plan_id_starts_on_ends_on_idx" ON "availability_entries"("plan_id", "starts_on", "ends_on");
