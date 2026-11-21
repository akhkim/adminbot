// Where API usage lives: a row per request and a rollup per day.
//
// Shaped like the error log next door: a small object the route context carries, with a memory
// form for tests and a SQLite form that shares the store's database. See contracts/api-usage.ts
// for what a row holds and, more to the point, what it never holds.
//
// Recording has to cost a request nothing it would notice. `record` only appends to a buffer; the
// buffer is written in one transaction when it fills or a couple of seconds pass, and the old rows
// are pruned at most once an hour from inside that same write. A crash loses the last few seconds
// of telemetry, which is the right trade for something no decision rests on.
import type { DatabaseSync } from "node:sqlite";
import {
  adminBotApiUsageRetentionDays,
  adminBotIsSweep,
  adminBotNotASweepOperations,
  type AdminBotAutomationSweep,
  type AdminBotApiUsageAdoption,
  type AdminBotApiUsageCount,
  type AdminBotApiUsageEntry,
  type AdminBotApiUsageSummary,
} from "../contracts/api-usage.js";

const API_USAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS adminbot_api_usage (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    member_id TEXT,
    auth TEXT NOT NULL,
    token_id TEXT,
    client TEXT NOT NULL,
    client_version TEXT,
    operation TEXT NOT NULL,
    method TEXT NOT NULL,
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    metrics_json TEXT
  );
  CREATE INDEX IF NOT EXISTS adminbot_api_usage_at_idx ON adminbot_api_usage(at);
  CREATE INDEX IF NOT EXISTS adminbot_api_usage_member_idx ON adminbot_api_usage(member_id, at);
  -- The automation report reads service-token rows only, and everything it reads is in this
  -- index, so its two scans of the window never touch the table.
  CREATE INDEX IF NOT EXISTS adminbot_api_usage_service_idx
    ON adminbot_api_usage(at, method, operation, status, duration_ms, metrics_json)
    WHERE auth = 'service';
  CREATE TABLE IF NOT EXISTS adminbot_api_usage_daily (
    day TEXT NOT NULL,
    member_id TEXT NOT NULL,
    auth TEXT NOT NULL,
    token_id TEXT NOT NULL,
    client TEXT NOT NULL,
    client_version TEXT NOT NULL,
    operation TEXT NOT NULL,
    method TEXT NOT NULL,
    requests INTEGER NOT NULL,
    client_errors INTEGER NOT NULL,
    server_errors INTEGER NOT NULL,
    total_ms INTEGER NOT NULL,
    max_ms INTEGER NOT NULL,
    last_at TEXT NOT NULL,
    PRIMARY KEY (day, member_id, auth, token_id, client, client_version, operation, method)
  );
  -- The summary and adoption reads group the window's cells by everything but day and token. In
  -- that order, and holding every summed column, this index answers them without a sort or a table
  -- read: 324k cells (the documented ceiling) take about 70 ms instead of 335.
  CREATE INDEX IF NOT EXISTS adminbot_api_usage_daily_group_idx ON adminbot_api_usage_daily(
    member_id, auth, client, client_version, method, operation, day,
    requests, client_errors, server_errors, total_ms, max_ms, last_at
  );
  -- First and last use per member and client. Not pruned: it is what keeps "first used the CLI"
  -- true after the request rows are gone, and it holds two timestamps and nothing else.
  CREATE TABLE IF NOT EXISTS adminbot_api_usage_members (
    member_id TEXT NOT NULL,
    client TEXT NOT NULL,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    PRIMARY KEY (member_id, client)
  );
`;

/** A request is written at most this long after it finished. */
const FLUSH_DELAY_MS = 2_000;
/** ...or as soon as this many are waiting. */
const FLUSH_BATCH = 200;
/** A buffer that cannot be written (a locked or broken database) stops growing here. */
const BUFFER_CAP = 5_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export type ApiUsageLog = {
  /** Queue one request. Never throws, never blocks on the database. */
  record(entry: AdminBotApiUsageEntry): void;
  /** Write whatever is queued. The timer calls it; tests and shutdown call it directly. */
  flush(now?: Date): void;
  summary(options?: { days?: number; now?: Date }): AdminBotApiUsageSummary;
  /** Newest first, for one member or everybody. */
  recent(options?: { memberId?: string; limit?: number }): AdminBotApiUsageEntry[];
  /** What each sweep endpoint did since `from`, busiest first: the automation report's sweeps. */
  sweeps(from: string): AdminBotAutomationSweep[];
  /** CLI adoption, power users and drop-off. `liveTokens` counts each member's live API tokens. */
  adoption(options: {
    days?: number;
    now?: Date;
    liveTokens: ReadonlyMap<string, number>;
  }): AdminBotApiUsageAdoption;
  close(): void;
};

/** When a member first and last used a client. */
export type ApiUsageMemberRow = {
  member_id: string;
  client: string;
  first_at: string;
  last_at: string;
};

/** Members who used the CLI before but not in this many days count as dropped off. */
const DROPPED_AFTER_DAYS = 30;
const TOP_OPERATIONS_PER_USER = 3;

/** One rollup cell: a day, a caller, a client, an operation. */
export type ApiUsageRollupRow = {
  day: string;
  member_id: string;
  auth: AdminBotApiUsageEntry["auth"];
  token_id: string;
  client: string;
  client_version: string;
  operation: string;
  method: string;
  requests: number;
  client_errors: number;
  server_errors: number;
  total_ms: number;
  max_ms: number;
  last_at: string;
};

/**
 * Where the day-by-member half of the window starts: early enough for both the window and the
 * weekly CLI series, so summary and adoption read the same scan.
 */
function pageDaysFrom(now: Date, from: string): string {
  const firstWeek = usageFirstWholeWeek(now);
  return firstWeek < from ? firstWeek : from;
}

function cutoffDay(now: Date, days: number): string {
  return new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

function clampDays(days: number | undefined): number {
  const value = Math.trunc(days ?? 30) || 30;
  return Math.min(Math.max(value, 1), adminBotApiUsageRetentionDays);
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 100) || 100, 1), 500);
}

function rollupKey(
  entry: AdminBotApiUsageEntry,
): Omit<
  ApiUsageRollupRow,
  "requests" | "client_errors" | "server_errors" | "total_ms" | "max_ms" | "last_at"
> {
  return {
    day: entry.at.slice(0, 10),
    member_id: entry.member_id ?? "",
    auth: entry.auth,
    token_id: entry.token_id ?? "",
    client: entry.client,
    client_version: entry.client_version ?? "",
    operation: entry.operation,
    method: entry.method,
  };
}

function errorCounts(status: number): { client_errors: number; server_errors: number } {
  return {
    client_errors: status >= 400 && status < 500 ? 1 : 0,
    server_errors: status >= 500 ? 1 : 0,
  };
}

type Accumulator = {
  requests: number;
  client_errors: number;
  server_errors: number;
  total_ms: number;
  max_ms: number;
};

function emptyAccumulator(): Accumulator {
  return { requests: 0, client_errors: 0, server_errors: 0, total_ms: 0, max_ms: 0 };
}

function add(into: Accumulator, row: ApiUsageRollupRow): void {
  into.requests += row.requests;
  into.client_errors += row.client_errors;
  into.server_errors += row.server_errors;
  into.total_ms += row.total_ms;
  into.max_ms = Math.max(into.max_ms, row.max_ms);
}

function counted(value: Accumulator): AdminBotApiUsageCount {
  return {
    requests: value.requests,
    client_errors: value.client_errors,
    server_errors: value.server_errors,
    avg_ms: value.requests ? Math.round(value.total_ms / value.requests) : 0,
    max_ms: value.max_ms,
  };
}

function groupBy<K extends string, T extends Record<string, unknown>>(
  rows: readonly ApiUsageRollupRow[],
  key: (row: ApiUsageRollupRow) => K,
  extra: (row: ApiUsageRollupRow) => T,
  more?: (into: T, row: ApiUsageRollupRow) => void,
): Array<AdminBotApiUsageCount & T> {
  const groups = new Map<K, { acc: Accumulator; extra: T }>();
  for (const row of rows) {
    const id = key(row);
    let group = groups.get(id);
    if (!group) {
      group = { acc: emptyAccumulator(), extra: extra(row) };
      groups.set(id, group);
    }
    add(group.acc, row);
    more?.(group.extra, row);
  }
  return [...groups.values()]
    .map((group) => ({ ...counted(group.acc), ...group.extra }))
    .toSorted((left, right) => right.requests - left.requests);
}

/** The admin page's numbers, from the rollup rows of the window. Shared by both stores. */
export function summarizeApiUsage(
  rows: readonly ApiUsageRollupRow[],
  options: { from: string; days: number },
): AdminBotApiUsageSummary {
  const total = emptyAccumulator();
  const members = new Set<string>();
  for (const row of rows) {
    add(total, row);
    if (row.member_id) {
      members.add(row.member_id);
    }
  }
  const byDay = summarizeDays(rows);
  const byMember = groupBy(
    rows.filter((row) => row.member_id),
    (row) => row.member_id,
    (row) => ({ member_id: row.member_id, last_at: "", cli_requests: 0, token_requests: 0 }),
    (into, row) => {
      if (row.last_at > into.last_at) {
        into.last_at = row.last_at;
      }
      if (row.client === "cli") {
        into.cli_requests += row.requests;
      }
      if (row.auth === "api_token") {
        into.token_requests += row.requests;
      }
    },
  );
  const byOperation = groupBy(
    rows,
    (row) => `${row.method} ${row.operation}`,
    (row) => ({ operation: row.operation, method: row.method }),
  );
  const byClient = groupBy(
    rows,
    (row) => `${row.client} ${row.client_version}`,
    (row) => ({
      client: row.client,
      ...(row.client_version ? { client_version: row.client_version } : {}),
    }),
  );
  const byAuth = groupBy(
    rows,
    (row) => row.auth,
    (row) => ({ auth: row.auth }),
  );
  return {
    from: options.from,
    days: options.days,
    totals: { ...counted(total), members: members.size },
    by_day: byDay,
    by_member: byMember,
    by_operation: byOperation,
    by_client: byClient,
    by_auth: byAuth,
  };
}

/** Requests per day, oldest first. */
export function summarizeDays(
  rows: readonly ApiUsageRollupRow[],
): AdminBotApiUsageSummary["by_day"] {
  return groupBy(
    rows,
    (row) => row.day,
    (row) => ({ day: row.day }),
  ).toSorted((left, right) => left.day.localeCompare(right.day));
}

/**
 * Per-member calls, client shares and per-operation counts, from people's rollup cells (no
 * service token, no empty member). Active days are left at 0: a cell may span several days, so
 * each store counts those itself.
 */
export function tallyPowerUsers(cells: readonly ApiUsageRollupRow[]): {
  power: ApiUsagePowerRow[];
  operations: ApiUsageMemberOperationRow[];
} {
  type Power = ApiUsagePowerRow & { opset: Set<string> };
  const power = new Map<string, Power>();
  const operations = new Map<string, ApiUsageMemberOperationRow>();
  for (const row of cells) {
    const entry: Power = power.get(row.member_id) ?? {
      member_id: row.member_id,
      requests: 0,
      active_days: 0,
      operations: 0,
      cli_requests: 0,
      website_requests: 0,
      other_requests: 0,
      last_at: row.last_at,
      opset: new Set(),
    };
    entry.requests += row.requests;
    if (row.client === "cli") {
      entry.cli_requests += row.requests;
    } else if (row.client === "website") {
      entry.website_requests += row.requests;
    } else {
      entry.other_requests += row.requests;
    }
    if (row.last_at > entry.last_at) {
      entry.last_at = row.last_at;
    }
    const opKey = `${row.method} ${row.operation}`;
    entry.opset.add(opKey);
    power.set(row.member_id, entry);
    const id = `${row.member_id}\u0000${opKey}`;
    const op = operations.get(id) ?? {
      member_id: row.member_id,
      operation: row.operation,
      method: row.method,
      requests: 0,
    };
    op.requests += row.requests;
    operations.set(id, op);
  }
  return {
    power: [...power.values()].map(({ opset, ...entry }) => ({ ...entry, operations: opset.size })),
    operations: [...operations.values()],
  };
}

/** The Monday (UTC) that starts the week a `YYYY-MM-DD` day falls in. */
export function usageWeekOf(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - sinceMonday * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The first Monday on or after the retention cutoff. Weeks before it are only partly in the log,
 * so their user counts would read as a dip that never happened.
 */
export function usageFirstWholeWeek(now: Date): string {
  const cutoff = cutoffDay(now, adminBotApiUsageRetentionDays);
  const week = usageWeekOf(cutoff);
  return week < cutoff
    ? new Date(Date.parse(`${week}T00:00:00.000Z`) + 7 * 86_400_000).toISOString().slice(0, 10)
    : week;
}

/** One member's calls in the window, before ranking. */
export type ApiUsagePowerRow = Omit<
  AdminBotApiUsageAdoption["power_users"][number],
  "top_operations"
>;

/** How often one member called one operation in the window. */
export type ApiUsageMemberOperationRow = {
  member_id: string;
  operation: string;
  method: string;
  requests: number;
};

/**
 * Adoption, power users and drop-off, from numbers either store has already added up: per-member
 * totals, per-member operation counts, distinct CLI users per whole week, and first/last use.
 */
export function finishApiAdoption(input: {
  now: Date;
  days: number;
  liveTokens: ReadonlyMap<string, number>;
  members: readonly ApiUsageMemberRow[];
  weekly: ReadonlyArray<{ week: string; users: number }>;
  power: readonly ApiUsagePowerRow[];
  operations: readonly ApiUsageMemberOperationRow[];
}): AdminBotApiUsageAdoption {
  const from = cutoffDay(input.now, input.days);
  const droppedBefore = new Date(
    input.now.getTime() - DROPPED_AFTER_DAYS * 86_400_000,
  ).toISOString();
  const cli = new Map(
    input.members.filter((row) => row.client === "cli").map((row) => [row.member_id, row]),
  );
  const people = new Set([
    ...[...input.liveTokens].filter(([, count]) => count > 0).map(([id]) => id),
    ...cli.keys(),
  ]);
  const memberRows = [...people]
    .map((memberId) => {
      const use = cli.get(memberId);
      return {
        member_id: memberId,
        live_tokens: input.liveTokens.get(memberId) ?? 0,
        ...(use ? { first_cli_at: use.first_at, last_cli_at: use.last_at } : {}),
      };
    })
    .toSorted(
      (left, right) =>
        (right.first_cli_at ?? "").localeCompare(left.first_cli_at ?? "") ||
        left.member_id.localeCompare(right.member_id),
    );

  const topOperations = new Map<string, ApiUsageMemberOperationRow[]>();
  for (const row of input.operations) {
    const list = topOperations.get(row.member_id) ?? [];
    list.push(row);
    topOperations.set(row.member_id, list);
  }
  const powerUsers = input.power
    .map((row) => ({
      ...row,
      top_operations: (topOperations.get(row.member_id) ?? [])
        .toSorted(
          (left, right) =>
            right.requests - left.requests ||
            `${left.method} ${left.operation}`.localeCompare(`${right.method} ${right.operation}`),
        )
        .slice(0, TOP_OPERATIONS_PER_USER)
        .map(({ operation, method, requests }) => ({ operation, method, requests })),
    }))
    .toSorted(
      (left, right) =>
        right.requests - left.requests ||
        right.active_days - left.active_days ||
        right.operations - left.operations ||
        left.member_id.localeCompare(right.member_id),
    );

  const holders = memberRows.filter((row) => row.live_tokens > 0);
  return {
    from,
    days: input.days,
    dropped_after_days: DROPPED_AFTER_DAYS,
    totals: {
      token_holders: holders.length,
      token_holders_using_cli: holders.filter((row) => row.first_cli_at).length,
      cli_users_ever: cli.size,
      cli_users_in_window: [...cli.values()].filter((row) => row.last_at.slice(0, 10) >= from)
        .length,
    },
    members: memberRows,
    weekly_cli_users: input.weekly
      .map(({ week, users }) => ({ week, users }))
      .toSorted((left, right) => left.week.localeCompare(right.week)),
    power_users: powerUsers,
    dropped_off: [...cli.values()]
      .filter((row) => row.last_at < droppedBefore)
      .map((row) => ({
        member_id: row.member_id,
        first_cli_at: row.first_at,
        last_cli_at: row.last_at,
      }))
      .toSorted((left, right) => right.last_cli_at.localeCompare(left.last_cli_at)),
  };
}

/** The memory store's adoption: the same sums `finishApiAdoption` takes, added up in JS. */
export function summarizeApiAdoption(
  rows: readonly ApiUsageRollupRow[],
  members: readonly ApiUsageMemberRow[],
  options: { now: Date; days: number; liveTokens: ReadonlyMap<string, number> },
): AdminBotApiUsageAdoption {
  const from = cutoffDay(options.now, options.days);
  const firstWeek = usageFirstWholeWeek(options.now);
  const weeks = new Map<string, Set<string>>();
  const activeDays = new Map<string, Set<string>>();
  const people: ApiUsageRollupRow[] = [];
  for (const row of rows) {
    if (!row.member_id) {
      continue;
    }
    if (row.client === "cli" && row.day >= firstWeek) {
      const users = weeks.get(usageWeekOf(row.day)) ?? new Set<string>();
      users.add(row.member_id);
      weeks.set(usageWeekOf(row.day), users);
    }
    if (row.day < from || row.auth === "service") {
      continue;
    }
    people.push(row);
    const days = activeDays.get(row.member_id) ?? new Set<string>();
    days.add(row.day);
    activeDays.set(row.member_id, days);
  }
  const { power, operations } = tallyPowerUsers(people);
  return finishApiAdoption({
    now: options.now,
    days: options.days,
    liveTokens: options.liveTokens,
    members,
    weekly: [...weeks].map(([week, users]) => ({ week, users: users.size })),
    power: power.map((row) => ({
      ...row,
      active_days: activeDays.get(row.member_id)?.size ?? 0,
    })),
    operations,
  });
}

/** The memory store's sweeps, from its raw rows. The SQLite store does this in SQL. */
export function summarizeSweeps(
  entries: readonly AdminBotApiUsageEntry[],
  from: string,
): AdminBotAutomationSweep[] {
  type Sweep = AdminBotAutomationSweep & { total_ms: number };
  const sweeps = new Map<string, Sweep>();
  for (const run of entries) {
    if (run.auth !== "service" || run.at < from || !adminBotIsSweep(run)) {
      continue;
    }
    const key = `${run.method} ${run.operation}`;
    const sweep: Sweep = sweeps.get(key) ?? {
      operation: run.operation,
      method: run.method,
      runs: 0,
      failures: 0,
      metrics: {},
      total_ms: 0,
    };
    sweeps.set(key, sweep);
    sweep.runs += 1;
    sweep.total_ms += run.duration_ms;
    sweep.max_ms = Math.max(sweep.max_ms ?? 0, run.duration_ms);
    if (!sweep.last_at || run.at > sweep.last_at) {
      sweep.last_at = run.at;
    }
    if (run.status >= 400) {
      sweep.failures += 1;
    } else if (!sweep.last_ok_at || run.at > sweep.last_ok_at) {
      sweep.last_ok_at = run.at;
    }
    for (const [name, value] of Object.entries(run.metrics ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) {
        sweep.metrics[name] = (sweep.metrics[name] ?? 0) + value;
      }
    }
  }
  return sortSweeps(
    [...sweeps.values()].map(({ total_ms, ...sweep }) => ({
      ...sweep,
      avg_ms: Math.round(total_ms / sweep.runs),
    })),
  );
}

function sortSweeps(sweeps: AdminBotAutomationSweep[]): AdminBotAutomationSweep[] {
  return sweeps.toSorted(
    (left, right) =>
      right.runs - left.runs ||
      `${left.method} ${left.operation}`.localeCompare(`${right.method} ${right.operation}`),
  );
}

/**
 * The buffer and its timer, shared by both stores so the memory one behaves like the real one in
 * tests: nothing is visible to `summary` until it has been flushed.
 */
function createBuffer(write: (entries: AdminBotApiUsageEntry[], now: Date) => void) {
  let pending: AdminBotApiUsageEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (now = new Date()) => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.length === 0) {
      return;
    }
    const batch = pending;
    pending = [];
    try {
      write(batch, now);
    } catch (error) {
      // Telemetry never fails the request it describes, and a database that cannot take this
      // batch now is unlikely to take it on a retry loop either. The batch is dropped, but said
      // out loud, so a usage page that stops moving has a reason in the service log. Only the
      // count and the database's message: never the rows, which name people.
      console.warn(
        `AdminBot API usage: dropped ${batch.length} request rows: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  return {
    record(entry: AdminBotApiUsageEntry) {
      if (pending.length >= BUFFER_CAP) {
        return;
      }
      pending.push(entry);
      if (pending.length >= FLUSH_BATCH) {
        flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(() => flush(), FLUSH_DELAY_MS);
        timer.unref?.();
      }
    },
    flush,
    close() {
      flush();
    },
  };
}

export function createMemoryApiUsageLog(): ApiUsageLog {
  const requests: AdminBotApiUsageEntry[] = [];
  const rollup = new Map<string, ApiUsageRollupRow>();
  const memberUse = new Map<string, ApiUsageMemberRow>();
  const buffer = createBuffer((entries) => {
    for (const entry of entries) {
      requests.push(entry);
      if (entry.member_id) {
        const useKey = `${entry.member_id}\u0000${entry.client}`;
        const use = memberUse.get(useKey);
        memberUse.set(useKey, {
          member_id: entry.member_id,
          client: entry.client,
          first_at: use && use.first_at < entry.at ? use.first_at : entry.at,
          last_at: use && use.last_at > entry.at ? use.last_at : entry.at,
        });
      }
      const key = rollupKey(entry);
      const id = Object.values(key).join("\u0000");
      const row = rollup.get(id) ?? {
        ...key,
        ...emptyAccumulator(),
        last_at: entry.at,
      };
      const errors = errorCounts(entry.status);
      rollup.set(id, {
        ...row,
        requests: row.requests + 1,
        client_errors: row.client_errors + errors.client_errors,
        server_errors: row.server_errors + errors.server_errors,
        total_ms: row.total_ms + entry.duration_ms,
        max_ms: Math.max(row.max_ms, entry.duration_ms),
        last_at: entry.at > row.last_at ? entry.at : row.last_at,
      });
    }
  });
  return {
    record: buffer.record,
    flush: buffer.flush,
    close: buffer.close,
    summary(options = {}) {
      const days = clampDays(options.days);
      const from = cutoffDay(options.now ?? new Date(), days);
      return summarizeApiUsage(
        [...rollup.values()].filter((row) => row.day >= from),
        { from, days },
      );
    },
    recent(options = {}) {
      return requests
        .filter((entry) => !options.memberId || entry.member_id === options.memberId)
        .toSorted((left, right) => right.at.localeCompare(left.at))
        .slice(0, clampLimit(options.limit));
    },
    sweeps(from) {
      return summarizeSweeps(requests, from);
    },
    adoption(options) {
      const now = options.now ?? new Date();
      const retained = cutoffDay(now, adminBotApiUsageRetentionDays);
      return summarizeApiAdoption(
        [...rollup.values()].filter((row) => row.day >= retained),
        [...memberUse.values()],
        { now, days: clampDays(options.days), liveTokens: options.liveTokens },
      );
    },
  };
}

export function createApiUsageLogFromDatabase(db: DatabaseSync): ApiUsageLog {
  db.exec(API_USAGE_SCHEMA);
  const insert = db.prepare(`
    INSERT INTO adminbot_api_usage
      (at, member_id, auth, token_id, client, client_version, operation, method, status, duration_ms,
       metrics_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsert = db.prepare(`
    INSERT INTO adminbot_api_usage_daily
      (day, member_id, auth, token_id, client, client_version, operation, method,
       requests, client_errors, server_errors, total_ms, max_ms, last_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(day, member_id, auth, token_id, client, client_version, operation, method)
    DO UPDATE SET
      requests = requests + 1,
      client_errors = client_errors + excluded.client_errors,
      server_errors = server_errors + excluded.server_errors,
      total_ms = total_ms + excluded.total_ms,
      max_ms = MAX(max_ms, excluded.max_ms),
      last_at = MAX(last_at, excluded.last_at)
  `);
  const touchMember = db.prepare(`
    INSERT INTO adminbot_api_usage_members (member_id, client, first_at, last_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(member_id, client) DO UPDATE SET
      first_at = MIN(first_at, excluded.first_at),
      last_at = MAX(last_at, excluded.last_at)
  `);
  const memberUse = db.prepare(`SELECT * FROM adminbot_api_usage_members`);
  const pruneRequests = db.prepare(`DELETE FROM adminbot_api_usage WHERE at < ?`);
  const pruneDaily = db.prepare(`DELETE FROM adminbot_api_usage_daily WHERE day < ?`);
  // The page reads sums, never rows. Each read is one or two scans of the window that SQLite
  // collapses to a few thousand cells (one per member, client and operation, or per day and
  // member); the shared JS above finishes those. A busy quarter costs a scan, not 300k objects.
  const COUNTS = `SUM(requests) AS requests, SUM(client_errors) AS client_errors,
    SUM(server_errors) AS server_errors, SUM(total_ms) AS total_ms, MAX(max_ms) AS max_ms,
    MAX(last_at) AS last_at`;
  const cellsSince = db.prepare(`
    SELECT member_id, auth, client, client_version, method, operation, ${COUNTS}
    FROM adminbot_api_usage_daily WHERE day >= ?
    GROUP BY member_id, auth, client, client_version, method, operation`);
  const dayMembersSince = db.prepare(`
    SELECT day, member_id, ${COUNTS}, MAX(client = 'cli') AS cli, MAX(auth <> 'service') AS person
    FROM adminbot_api_usage_daily WHERE day >= ? GROUP BY day, member_id`);
  // The window the page reads, grouped twice: cells (member, client and operation, for summary and
  // adoption) and day by member (for by_day, weekly CLI users and active days). One scan of each
  // serves every read until something other than a flush writes. A flush adds the rows it wrote to
  // both maps instead of throwing them away, because each GET the page sends is itself a usage row
  // that the next GET flushes: dropping the window there made every page load scan four times.
  // Keyed on total_changes(): any other write on this connection (a prune, a member merge, purge
  // or rename, a store write) makes the next read scan again, so the window is never stale.
  type DayMember = { row: ApiUsageRollupRow; cli: boolean; person: boolean };
  type UsageWindow = {
    from: string;
    daysFrom: string;
    version: number;
    cells: Map<string, ApiUsageRollupRow>;
    days: Map<string, DayMember>;
    sorted: boolean;
  };
  const changes = db.prepare(`SELECT total_changes() AS n`);
  const version = () => Number((changes.get() as { n: number }).n);
  const cellKey = (row: Omit<ApiUsageRollupRow, "day">) =>
    [row.member_id, row.auth, row.client, row.client_version, row.method, row.operation].join(
      "\u0000",
    );
  let window: UsageWindow | undefined;
  const windowSince = (from: string, daysFrom: string): UsageWindow => {
    const now = version();
    if (window?.from !== from || window.daysFrom !== daysFrom || window.version !== now) {
      const cells = new Map<string, ApiUsageRollupRow>();
      for (const row of cellsSince.all(from) as Array<Record<string, unknown>>) {
        const cell = rollupFromSqlite({ ...row, day: from });
        cells.set(cellKey(cell), cell);
      }
      const days = new Map<string, DayMember>();
      for (const row of dayMembersSince.all(daysFrom) as Array<Record<string, unknown>>) {
        const day = rollupFromSqlite({ ...row, auth: "", client: "", operation: "", method: "" });
        days.set(`${day.day}\u0000${day.member_id}`, {
          row: day,
          cli: Number(row.cli) === 1,
          person: Number(row.person) === 1,
        });
      }
      window = { from, daysFrom, version: now, cells, days, sorted: true };
    }
    if (!window.sorted) {
      // A flush appends cells it had not seen. Put them back in the scan's order, so tied counts
      // list the same way whether this read scanned or not.
      window.cells = new Map(
        [...window.cells].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      window.days = new Map([...window.days].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      window.sorted = true;
    }
    return window;
  };
  const addTo = (into: ApiUsageRollupRow, row: ApiUsageRollupRow) => {
    add(into, row);
    if (row.last_at > into.last_at) {
      into.last_at = row.last_at;
    }
  };
  /** Adds a flushed batch to the window, as the upsert added it to the rollup. */
  const patchWindow = (open: UsageWindow, entries: readonly AdminBotApiUsageEntry[]) => {
    for (const entry of entries) {
      const key = rollupKey(entry);
      const one: ApiUsageRollupRow = {
        ...key,
        token_id: "",
        requests: 1,
        ...errorCounts(entry.status),
        total_ms: entry.duration_ms,
        max_ms: entry.duration_ms,
        last_at: entry.at,
      };
      if (key.day >= open.from) {
        const id = cellKey(one);
        const cell = open.cells.get(id);
        if (cell) {
          addTo(cell, one);
        } else {
          open.cells.set(id, { ...one, day: open.from });
          open.sorted = false;
        }
      }
      if (key.day >= open.daysFrom) {
        const id = `${key.day}\u0000${key.member_id}`;
        const day = open.days.get(id);
        if (day) {
          addTo(day.row, one);
          day.cli ||= entry.client === "cli";
          day.person ||= entry.auth !== "service";
        } else {
          open.days.set(id, {
            row: {
              ...one,
              auth: "" as ApiUsageRollupRow["auth"],
              client: "",
              operation: "",
              method: "",
              client_version: "",
            },
            cli: entry.client === "cli",
            person: entry.auth !== "service",
          });
          open.sorted = false;
        }
      }
    }
  };
  const recentAll = db.prepare(`SELECT * FROM adminbot_api_usage ORDER BY at DESC LIMIT ?`);
  const recentForMember = db.prepare(
    `SELECT * FROM adminbot_api_usage WHERE member_id = ? ORDER BY at DESC LIMIT ?`,
  );
  // Sweeps: service-token writes, minus the heartbeat. Read from the covering service index.
  const notSweeps = adminBotNotASweepOperations.map((operation) => `'${operation}'`).join(", ");
  const SWEEPS = `FROM adminbot_api_usage
    WHERE auth = 'service' AND at >= ? AND method <> 'GET' AND operation NOT IN (${notSweeps})`;
  const sweepsSince = db.prepare(`
    SELECT method, operation, COUNT(*) AS runs, SUM(status >= 400) AS failures,
      CAST(ROUND(AVG(duration_ms)) AS INTEGER) AS avg_ms, MAX(duration_ms) AS max_ms,
      MAX(at) AS last_at, MAX(CASE WHEN status < 400 THEN at END) AS last_ok_at
    ${SWEEPS} GROUP BY method, operation`);
  const sweepMetricsSince = db.prepare(`
    SELECT method, operation, metric.key AS name, SUM(metric.value) AS total
    FROM (SELECT method, operation, metrics_json ${SWEEPS} AND metrics_json IS NOT NULL) AS run,
      json_each(run.metrics_json) AS metric
    WHERE metric.type IN ('integer', 'real')
    GROUP BY method, operation, metric.key`);
  let prunedAt = 0;
  const buffer = createBuffer((entries, now) => {
    const before = version();
    let pruned = false;
    db.exec("BEGIN");
    try {
      for (const entry of entries) {
        const key = rollupKey(entry);
        const errors = errorCounts(entry.status);
        insert.run(
          entry.at,
          entry.member_id ?? null,
          entry.auth,
          entry.token_id ?? null,
          entry.client,
          entry.client_version ?? null,
          entry.operation,
          entry.method,
          entry.status,
          entry.duration_ms,
          entry.metrics ? JSON.stringify(entry.metrics) : null,
        );
        upsert.run(
          key.day,
          key.member_id,
          key.auth,
          key.token_id,
          key.client,
          key.client_version,
          key.operation,
          key.method,
          errors.client_errors,
          errors.server_errors,
          entry.duration_ms,
          entry.duration_ms,
          entry.at,
        );
        if (entry.member_id) {
          touchMember.run(entry.member_id, entry.client, entry.at, entry.at);
        }
      }
      if (now.getTime() - prunedAt >= PRUNE_EVERY_MS) {
        prunedAt = now.getTime();
        pruned = true;
        const cutoff = new Date(now.getTime() - adminBotApiUsageRetentionDays * 86_400_000);
        pruneRequests.run(cutoff.toISOString());
        pruneDaily.run(cutoff.toISOString().slice(0, 10));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (window && !pruned && window.version === before) {
      patchWindow(window, entries);
      window.version = version();
    }
  });
  return {
    record: buffer.record,
    flush: buffer.flush,
    close: buffer.close,
    summary(options = {}) {
      const days = clampDays(options.days);
      const from = cutoffDay(options.now ?? new Date(), days);
      const open = windowSince(from, pageDaysFrom(options.now ?? new Date(), from));
      const byDay = [...open.days.values()]
        .filter(({ row }) => row.day >= from)
        .map(({ row }) => row);
      return {
        ...summarizeApiUsage([...open.cells.values()], { from, days }),
        by_day: summarizeDays(byDay),
      };
    },
    recent(options = {}) {
      const limit = clampLimit(options.limit);
      const rows = (
        options.memberId ? recentForMember.all(options.memberId, limit) : recentAll.all(limit)
      ) as Array<Record<string, unknown>>;
      return rows.map(entryFromSqlite);
    },
    sweeps(from) {
      const metrics = new Map<string, Record<string, number>>();
      for (const row of sweepMetricsSince.all(from) as Array<Record<string, unknown>>) {
        const key = `${String(row.method)} ${String(row.operation)}`;
        metrics.set(key, { ...metrics.get(key), [String(row.name)]: Number(row.total) });
      }
      return sortSweeps(
        (sweepsSince.all(from) as Array<Record<string, unknown>>).map((row) => ({
          operation: String(row.operation),
          method: String(row.method),
          runs: Number(row.runs),
          failures: Number(row.failures),
          avg_ms: Number(row.avg_ms),
          max_ms: Number(row.max_ms),
          last_at: String(row.last_at),
          ...(row.last_ok_at ? { last_ok_at: String(row.last_ok_at) } : {}),
          metrics: metrics.get(`${String(row.method)} ${String(row.operation)}`) ?? {},
        })),
      );
    },
    adoption(options) {
      const now = options.now ?? new Date();
      const days = clampDays(options.days);
      const from = cutoffDay(now, days);
      const members = (memberUse.all() as Array<Record<string, unknown>>).map((row) => ({
        member_id: String(row.member_id),
        client: String(row.client),
        first_at: String(row.first_at),
        last_at: String(row.last_at),
      }));
      const firstWeek = usageFirstWholeWeek(now);
      const open = windowSince(from, pageDaysFrom(now, from));
      const weeks = new Map<string, Set<string>>();
      const activeDays = new Map<string, number>();
      for (const { row, cli, person } of open.days.values()) {
        const { day, member_id: memberId } = row;
        if (!memberId) {
          continue;
        }
        if (cli && day >= firstWeek) {
          const users = weeks.get(usageWeekOf(day)) ?? new Set<string>();
          users.add(memberId);
          weeks.set(usageWeekOf(day), users);
        }
        if (person && day >= from) {
          activeDays.set(memberId, (activeDays.get(memberId) ?? 0) + 1);
        }
      }
      const people = [...open.cells.values()].filter(
        (row) => row.member_id && row.auth !== "service",
      );
      const { power, operations } = tallyPowerUsers(people);
      return finishApiAdoption({
        now,
        days,
        liveTokens: options.liveTokens,
        members,
        weekly: [...weeks].map(([week, users]) => ({ week, users: users.size })),
        power: power.map((row) => ({ ...row, active_days: activeDays.get(row.member_id) ?? 0 })),
        operations,
      });
    },
  };
}

/**
 * Moves one member's usage onto another when two member records are merged. The rollup and the
 * first/last table are keyed by member, so a plain re-key would collide wherever both members
 * have a cell for the same day and operation. Colliding cells are added together instead, and
 * first/last use keeps the earlier first and the later last. Request rows have no key to collide
 * on and move with the generic re-key. Call inside the merge's transaction.
 */
export function mergeApiUsageMember(
  db: DatabaseSync,
  from: string,
  to: string,
): { daily: number; members: number } {
  db.exec(API_USAGE_SCHEMA);
  const daily = db
    .prepare(
      `INSERT INTO adminbot_api_usage_daily
         (day, member_id, auth, token_id, client, client_version, operation, method,
          requests, client_errors, server_errors, total_ms, max_ms, last_at)
       SELECT day, ?, auth, token_id, client, client_version, operation, method,
          requests, client_errors, server_errors, total_ms, max_ms, last_at
       FROM adminbot_api_usage_daily WHERE member_id = ? AND true
       ON CONFLICT(day, member_id, auth, token_id, client, client_version, operation, method)
       DO UPDATE SET
         requests = requests + excluded.requests,
         client_errors = client_errors + excluded.client_errors,
         server_errors = server_errors + excluded.server_errors,
         total_ms = total_ms + excluded.total_ms,
         max_ms = MAX(max_ms, excluded.max_ms),
         last_at = MAX(last_at, excluded.last_at)`,
    )
    .run(to, from);
  db.prepare(`DELETE FROM adminbot_api_usage_daily WHERE member_id = ?`).run(from);
  const members = db
    .prepare(
      `INSERT INTO adminbot_api_usage_members (member_id, client, first_at, last_at)
       SELECT ?, client, first_at, last_at FROM adminbot_api_usage_members
       WHERE member_id = ? AND true
       ON CONFLICT(member_id, client) DO UPDATE SET
         first_at = MIN(first_at, excluded.first_at),
         last_at = MAX(last_at, excluded.last_at)`,
    )
    .run(to, from);
  db.prepare(`DELETE FROM adminbot_api_usage_members WHERE member_id = ?`).run(from);
  return { daily: Number(daily.changes), members: Number(members.changes) };
}

function rollupFromSqlite(row: Record<string, unknown>): ApiUsageRollupRow {
  return {
    day: String(row.day),
    member_id: String(row.member_id ?? ""),
    auth: String(row.auth) as ApiUsageRollupRow["auth"],
    token_id: String(row.token_id ?? ""),
    client: String(row.client),
    client_version: String(row.client_version ?? ""),
    operation: String(row.operation),
    method: String(row.method),
    requests: Number(row.requests) || 0,
    client_errors: Number(row.client_errors) || 0,
    server_errors: Number(row.server_errors) || 0,
    total_ms: Number(row.total_ms) || 0,
    max_ms: Number(row.max_ms) || 0,
    last_at: String(row.last_at),
  };
}

function entryFromSqlite(row: Record<string, unknown>): AdminBotApiUsageEntry {
  return {
    at: String(row.at),
    ...(typeof row.member_id === "string" ? { member_id: row.member_id } : {}),
    auth: String(row.auth) as AdminBotApiUsageEntry["auth"],
    ...(typeof row.token_id === "string" ? { token_id: row.token_id } : {}),
    client: String(row.client) as AdminBotApiUsageEntry["client"],
    ...(typeof row.client_version === "string" ? { client_version: row.client_version } : {}),
    operation: String(row.operation),
    method: String(row.method),
    status: Number(row.status) || 0,
    duration_ms: Number(row.duration_ms) || 0,
    ...metricsFromSqlite(row.metrics_json),
  };
}

function metricsFromSqlite(raw: unknown): { metrics?: Record<string, number> } {
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { metrics: parsed as Record<string, number> }
      : {};
  } catch {
    return {};
  }
}
