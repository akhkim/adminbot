-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_legacy_migration_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "mapper_set_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "redacted_report" JSONB NOT NULL,
    "started_at" DATETIME NOT NULL,
    "completed_at" DATETIME
);
INSERT INTO "new_legacy_migration_runs" ("completed_at", "id", "mapper_set_version", "redacted_report", "scope", "source_fingerprint", "started_at", "status") SELECT "completed_at", "id", "mapper_set_version", "redacted_report", 'full', "source_fingerprint", "started_at", "status" FROM "legacy_migration_runs";
DROP TABLE "legacy_migration_runs";
ALTER TABLE "new_legacy_migration_runs" RENAME TO "legacy_migration_runs";
CREATE UNIQUE INDEX "legacy_migration_runs_scope_source_fingerprint_mapper_set_version_key" ON "legacy_migration_runs"("scope", "source_fingerprint", "mapper_set_version");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
