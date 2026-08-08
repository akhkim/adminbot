CREATE TABLE "member_profiles" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "preferred_name" TEXT,
  "institutional_email" TEXT,
  "biography" TEXT,
  "research_topics" JSONB NOT NULL DEFAULT '[]',
  "profile_image_artifact_id" TEXT,
  "field_visibility" JSONB NOT NULL DEFAULT '{"preferredName":"members","institutionalEmail":"members","biography":"members","researchTopics":"members","profileImageArtifactId":"members"}',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "member_profiles_person_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "people" ("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_profiles_research_topics_json_check" CHECK (json_valid("research_topics")),
  CONSTRAINT "member_profiles_field_visibility_json_check" CHECK (json_valid("field_visibility"))
);

CREATE UNIQUE INDEX "member_profiles_organization_id_person_id_key" ON "member_profiles"("organization_id", "person_id");
CREATE INDEX "member_profiles_organization_id_updated_at_idx" ON "member_profiles"("organization_id", "updated_at");

CREATE TABLE "memberships" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "tier" TEXT NOT NULL DEFAULT 'external_collaborator' CHECK ("tier" IN ('external_collaborator', 'member')),
  "lifecycle" TEXT NOT NULL DEFAULT 'active' CHECK ("lifecycle" IN ('applicant', 'accepted', 'onboarding', 'active', 'leave', 'departing', 'alumni')),
  "start_date" TEXT,
  "end_date" TEXT,
  "mentor_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "memberships_person_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "people" ("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "memberships_mentor_fkey" FOREIGN KEY ("organization_id", "mentor_id") REFERENCES "people" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "memberships_organization_id_person_id_key" ON "memberships"("organization_id", "person_id");
CREATE INDEX "memberships_organization_id_lifecycle_idx" ON "memberships"("organization_id", "lifecycle");
CREATE INDEX "memberships_organization_id_mentor_id_idx" ON "memberships"("organization_id", "mentor_id");

INSERT INTO "member_profiles" (
  "id", "organization_id", "person_id", "research_topics", "field_visibility",
  "version", "created_at", "updated_at"
)
SELECT
  "id", "organization_id", "id", '[]',
  '{"preferredName":"members","institutionalEmail":"members","biography":"members","researchTopics":"members","profileImageArtifactId":"members"}',
  1, "created_at", "updated_at"
FROM "people";

INSERT INTO "memberships" (
  "id", "organization_id", "person_id", "tier", "lifecycle", "version", "created_at", "updated_at"
)
SELECT
  p."id", p."organization_id", p."id",
  CASE WHEN EXISTS (
    SELECT 1 FROM "role_assignments" r
    WHERE r."organization_id" = p."organization_id"
      AND r."person_id" = p."id"
      AND r."role" IN ('member', 'administrator')
      AND (r."valid_until" IS NULL OR r."valid_until" > CURRENT_TIMESTAMP)
  ) THEN 'member' ELSE 'external_collaborator' END,
  'active', 1, p."created_at", p."updated_at"
FROM "people" p;
