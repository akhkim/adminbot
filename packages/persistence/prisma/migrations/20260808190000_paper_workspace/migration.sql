CREATE TABLE "papers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author_ids" JSONB NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'idea',
    "target_venue" TEXT,
    "deadline_at" DATETIME,
    "source_uri" TEXT,
    "topic_tags" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE INDEX "papers_organization_id_stage_idx" ON "papers"("organization_id", "stage");
CREATE INDEX "papers_organization_id_deadline_at_idx" ON "papers"("organization_id", "deadline_at");
