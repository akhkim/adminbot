import type { DatabaseSync } from "node:sqlite";
import type { AdminBotLabMember } from "../contracts/actions.js";
import type { AdminBotLabMemberSummary } from "../kernel/service.js";
import { registerSqliteCacheInvalidator } from "./sqlite.cache-invalidation.js";

type Snapshot = {
  version: number;
  members: readonly AdminBotLabMember[];
  byId: ReadonlyMap<string, AdminBotLabMember>;
  summaries?: readonly AdminBotLabMemberSummary[];
};

/**
 * The parsed roster, kept until a member is written.
 *
 * On Aurora the roster is ~6MB of JSON (inline avatars, onboarding) and most requests and sweeps
 * read all of it. Writes through the store call `invalidate()`; `PRAGMA data_version` catches
 * commits from any other connection (scripts, a second process) without a write hook.
 *
 * Members are shared objects, as in the in-memory store: change one, then save it.
 */
export class SqliteLabMemberCache {
  private snapshot: Snapshot | undefined;

  constructor(private readonly db: DatabaseSync) {
    // Writers on this same connection outside the store (inference gate, task runner) call
    // invalidateSqliteCaches; data_version only sees other connections' commits.
    registerSqliteCacheInvalidator(db, () => this.invalidate());
  }

  invalidate(): void {
    this.snapshot = undefined;
  }

  list(): readonly AdminBotLabMember[] {
    return this.current().members;
  }

  get(memberId: string): AdminBotLabMember | undefined {
    return this.current().byId.get(memberId);
  }

  summaries(): readonly AdminBotLabMemberSummary[] {
    const snapshot = this.current();
    snapshot.summaries ??= (
      this.db
        .prepare(
          `SELECT id FROM adminbot_lab_members
           ORDER BY adminbot_lower(json_extract(payload_json, '$.name')), id`,
        )
        .all() as Array<{ id: string }>
    ).map(({ id }) => summarize(snapshot.byId.get(id)!));
    return snapshot.summaries;
  }

  private current(): Snapshot {
    const { data_version: version } = this.db.prepare("PRAGMA data_version").get() as {
      data_version: number;
    };
    if (this.snapshot?.version === version) {
      return this.snapshot;
    }
    const members = (
      this.db
        .prepare(
          `SELECT payload_json FROM adminbot_lab_members
           ORDER BY json_extract(payload_json, '$.name')`,
        )
        .all() as Array<{ payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json) as AdminBotLabMember);
    this.snapshot = { version, members, byId: new Map(members.map((m) => [m.id, m])) };
    return this.snapshot;
  }
}

function summarize(member: AdminBotLabMember): AdminBotLabMemberSummary {
  const { field_provenance: _provenance, access: _access, ...summary } = member;
  if (summary.onboarding && !Array.isArray(summary.onboarding)) {
    return {
      ...summary,
      onboarding: {
        steps: Array.isArray(summary.onboarding.steps)
          ? summary.onboarding.steps.map(({ id, status }) => ({ id, status }))
          : [],
      },
    } as AdminBotLabMemberSummary;
  }
  return summary as AdminBotLabMemberSummary;
}
