-- CreateTable
CREATE TABLE "people" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "login_handle" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "accounts_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "people" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "requested_login_handle" TEXT NOT NULL,
    "requested_display_name" TEXT NOT NULL,
    "password_hash" TEXT,
    "linked_person_id" TEXT,
    "reviewed_by_person_id" TEXT,
    "reviewed_at" DATETIME,
    "review_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "registration_profiles" (
    "registration_id" TEXT NOT NULL PRIMARY KEY,
    "slack_user_id" TEXT,
    "role" TEXT,
    "affiliation" TEXT,
    "research_branch" TEXT,
    "research_topics" JSONB,
    "projects" JSONB,
    "hours_per_week" REAL,
    "location" TEXT,
    "timezone" TEXT,
    "personal_website" TEXT,
    "notes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "registration_profiles_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "last_seen_at" DATETIME NOT NULL,
    "last_reauthenticated_at" DATETIME NOT NULL,
    "revoked_at" DATETIME,
    "revocation_reason" TEXT,
    CONSTRAINT "sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "valid_from" DATETIME NOT NULL,
    "valid_until" DATETIME,
    "assigned_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "role_assignments_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "people" ("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "subject_id" TEXT,
    "correlation_id" TEXT,
    "safe_details" JSONB NOT NULL,
    "occurred_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organization_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" DATETIME NOT NULL,
    "claimed_at" DATETIME,
    "delivered_at" DATETIME,
    "last_error_code" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "legacy_migration_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source_fingerprint" TEXT NOT NULL,
    "mapper_set_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "redacted_report" JSONB NOT NULL,
    "started_at" DATETIME NOT NULL,
    "completed_at" DATETIME
);

-- CreateTable
CREATE TABLE "legacy_identity_links" (
    "legacy_member_id" TEXT NOT NULL PRIMARY KEY,
    "person_id" TEXT NOT NULL,
    "imported_at" DATETIME NOT NULL,
    CONSTRAINT "legacy_identity_links_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "people_organization_id_status_idx" ON "people"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "people_organization_id_id_key" ON "people"("organization_id", "id");

-- CreateIndex
CREATE INDEX "accounts_organization_id_status_idx" ON "accounts"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_organization_id_login_handle_key" ON "accounts"("organization_id", "login_handle");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_organization_id_person_id_key" ON "accounts"("organization_id", "person_id");

-- CreateIndex
CREATE INDEX "registrations_organization_id_status_created_at_idx" ON "registrations"("organization_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_organization_id_requested_login_handle_status_key" ON "registrations"("organization_id", "requested_login_handle", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_account_id_expires_at_idx" ON "sessions"("account_id", "expires_at");

-- CreateIndex
CREATE INDEX "role_assignments_organization_id_role_valid_until_idx" ON "role_assignments"("organization_id", "role", "valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignments_organization_id_person_id_role_valid_from_key" ON "role_assignments"("organization_id", "person_id", "role", "valid_from");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_occurred_at_idx" ON "audit_events"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_correlation_id_idx" ON "audit_events"("correlation_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_organization_id_aggregate_type_aggregate_id_idx" ON "outbox_events"("organization_id", "aggregate_type", "aggregate_id");

-- CreateIndex
CREATE UNIQUE INDEX "legacy_migration_runs_source_fingerprint_mapper_set_version_key" ON "legacy_migration_runs"("source_fingerprint", "mapper_set_version");

-- CreateIndex
CREATE UNIQUE INDEX "legacy_identity_links_person_id_key" ON "legacy_identity_links"("person_id");
