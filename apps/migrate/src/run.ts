import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { openPersistence } from "@adminbot/persistence";
import type { JsonValue } from "@adminbot/ports";
import { IDENTITY_MAPPER_SET_VERSION, mapLegacyIdentity, type MigrationIssue } from "./identity-mapper.js";
import { readLegacyIdentitySnapshot } from "./legacy-source.js";
import {
  backupSqlite,
  createBackupPath,
  safeBackupLabel,
  sha256File,
} from "./sqlite-files.js";

export interface LegacyIdentityMigrationOptions {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly backupDirectory: string;
  readonly organizationId: string;
  readonly apply?: boolean;
  readonly invalidateLegacySessions?: boolean;
  readonly now?: () => Date;
}

export interface LegacyIdentityMigrationResult {
  readonly outcome: "already_applied" | "applied" | "dry_run" | "invalid";
  readonly sourceBackupCreated: true;
  readonly destinationBackupCreated: boolean;
  readonly report: JsonValue;
  readonly issues: readonly MigrationIssue[];
}

export async function runLegacyIdentityMigration(
  options: LegacyIdentityMigrationOptions,
): Promise<LegacyIdentityMigrationResult> {
  assertAbsoluteFileOption(options.sourcePath, "sourcePath");
  assertAbsoluteFileOption(options.destinationPath, "destinationPath");
  assertAbsoluteFileOption(options.backupDirectory, "backupDirectory");
  if (!isUuid(options.organizationId)) throw new Error("organizationId must be a UUID");
  if (resolve(options.sourcePath) === resolve(options.destinationPath)) {
    throw new Error("source and destination SQLite paths must differ");
  }
  if (!existsSync(options.sourcePath)) throw new Error("legacy source SQLite file does not exist");

  const sourceBackupPath = createBackupPath(
    options.backupDirectory,
    safeBackupLabel(options.sourcePath, "source"),
  );
  await backupSqlite(options.sourcePath, sourceBackupPath);
  const sourceFingerprint = await sha256File(sourceBackupPath);
  const snapshot = readLegacyIdentitySnapshot(sourceBackupPath);
  const completedAt = options.now?.() ?? new Date();
  const mapping = mapLegacyIdentity(snapshot, {
    organizationId: options.organizationId,
    sourceFingerprint,
    completedAt,
  });
  if (mapping.batch === undefined) {
    return {
      outcome: "invalid",
      sourceBackupCreated: true,
      destinationBackupCreated: false,
      report: mapping.report,
      issues: mapping.issues,
    };
  }
  const batch = mapping.batch;
  if (!options.apply) {
    return {
      outcome: "dry_run",
      sourceBackupCreated: true,
      destinationBackupCreated: false,
      report: mapping.report,
      issues: [],
    };
  }
  if (snapshot.legacySessionCount > 0 && options.invalidateLegacySessions !== true) {
    throw new Error("apply requires explicit legacy-session invalidation acknowledgement");
  }

  let destinationBackupCreated = false;
  if (existsSync(options.destinationPath)) {
    const destinationBackupPath = createBackupPath(
      options.backupDirectory,
      safeBackupLabel(options.destinationPath, "destination"),
    );
    await backupSqlite(options.destinationPath, destinationBackupPath);
    destinationBackupCreated = true;
  }
  const persistence = openPersistence({ databaseUrl: `file:${options.destinationPath}` });
  try {
    const outcome = await persistence.transactions.write(async ({ audit, legacyMigration }) => {
      const alreadyApplied = await legacyMigration.hasCompletedRun(
        "identity",
        sourceFingerprint,
        IDENTITY_MAPPER_SET_VERSION,
      );
      if (alreadyApplied) return "already_applied" as const;
      await legacyMigration.importIdentity(batch);
      await audit.append({
        id: stableAuditId(sourceFingerprint, options.organizationId),
        organizationId: options.organizationId,
        eventType: "migration.legacy_identity_completed",
        safeDetails: {
          mapperSetVersion: IDENTITY_MAPPER_SET_VERSION,
          people: batch.people.length,
          accounts: batch.accounts.length,
          registrations: batch.registrations.length,
          legacySessionsInvalidated: snapshot.legacySessionCount,
        },
        occurredAt: completedAt,
      });
      return "applied" as const;
    });
    return {
      outcome,
      sourceBackupCreated: true,
      destinationBackupCreated,
      report: mapping.report,
      issues: [],
    };
  } finally {
    await persistence.close();
  }
}

function assertAbsoluteFileOption(value: string, name: string): void {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function stableAuditId(sourceFingerprint: string, organizationId: string): string {
  const hex = createHash("sha256")
    .update("legacy-identity-audit\0")
    .update(sourceFingerprint)
    .update("\0")
    .update(organizationId)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "8";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
