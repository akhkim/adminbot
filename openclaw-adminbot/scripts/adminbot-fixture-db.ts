// Builds a throwaway adminbot.sqlite full of obviously-fake data, so load and concurrency work can
// be run against production *scale* without production *content*.
//
//   node --import tsx scripts/adminbot-fixture-db.ts [db] [--write] [--members 160] [--seed 1]
//
// Dry run by default, like scripts/adminbot-seed-member-passwords.ts: it reports exactly what it
// would write and creates nothing. `--write` is the only thing that touches the disk.
//
// Why generate instead of copying a real database: the thing Task 4 cares about is 100+ members
// against one GPU, and that is a *shape* -- a roster size, a paper count, a distribution of
// proposals -- not a set of facts. Copying a real roster to get the shape would put 159 named
// people and their credentials into a test fixture that then gets passed around, committed by
// accident, and left on disk. Nothing here is read from a real database, bundle, or export.
//
// The schema is not restated here. `new AdminBotSqliteStore(path)` runs the real CREATE TABLE
// statements from extensions/adminbot/src/persistence/sqlite.ts, and the rows go in through the
// real store methods, so a fixture cannot drift from the schema the service actually reads. A
// hand-written copy of the DDL would have been wrong the first time a column was added.
//
// Every generated address is on a domain that cannot resolve (example.com / example.org /
// .invalid, reserved by RFC 2606 and RFC 6761 precisely so that test data cannot reach anyone).
// That is deliberate belt-and-braces: a fixture is exactly the kind of file someone eventually
// points a real mailer at, and the failure mode of a plausible-looking domain is mail to a
// stranger. The lab's own domain never appears in this file.
import fs from "node:fs";
import path from "node:path";
import {
  adminBotMemberStatuses,
  adminBotPaperSteps,
  adminBotPrivilegeLevels,
  adminBotRiskTiers,
  type AdminBotAuditEvent,
  type AdminBotExecutionResult,
  type AdminBotLabMember,
  type AdminBotPaperRecord,
  type AdminBotStoredProposal,
} from "../extensions/adminbot/src/contracts/actions.ts";
import { AdminBotSqliteStore } from "../extensions/adminbot/src/persistence/sqlite.ts";

// The live roster is 159 people. Defaulting to 160 means a load run reproduces the queue depth the
// real deployment sees rather than a tidy round number that happens to be smaller.
const DEFAULT_MEMBERS = 160;
const DEFAULT_PAPERS = 40;
const DEFAULT_PROPOSALS = 24;

// Under .artifacts/ because that path is already gitignored, so a fixture cannot be committed by
// an absent-minded `git add -A`. Never defaults to ~/.openclaw/state/adminbot.sqlite -- see
// assertSafeTarget.
const DEFAULT_DB = ".artifacts/adminbot-task4/adminbot-fixture.sqlite";

/** RFC 2606 / RFC 6761 reserved. None of these resolve, and none can be registered. */
const SAFE_EMAIL_DOMAINS = ["example.com", "example.org", "example.invalid"] as const;

const RESEARCH_BRANCHES = [
  "Synthetic Branch Alpha",
  "Synthetic Branch Beta",
  "Synthetic Branch Gamma",
  "Synthetic Branch Delta",
] as const;

const RESEARCH_TOPICS = [
  "placeholder-topic-one",
  "placeholder-topic-two",
  "placeholder-topic-three",
  "placeholder-topic-four",
  "placeholder-topic-five",
] as const;

const MEMBER_TYPES = ["full", "alumni", "coauthor-major", "coauthor-minor", "interviewee"] as const;

/**
 * mulberry32: a small, fast, fully deterministic PRNG.
 *
 * Determinism is the point of the whole script. A load test that shows a regression has to be
 * re-runnable against the identical roster, and `Math.random` would give every run a different
 * distribution of privilege levels and paper steps -- so a queue that only misbehaves on a roster
 * with 30 admins would appear and disappear between runs with no way to pin it.
 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Options = {
  databasePath: string;
  write: boolean;
  members: number;
  papers: number;
  proposals: number;
  seed: number;
  force: boolean;
};

function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `Generates a synthetic AdminBot database for load and concurrency testing.

  node --import tsx scripts/adminbot-fixture-db.ts [db] [options]

  --write            Actually create the database. Without it this is a dry run.
  --members <n>      Roster size. Default ${DEFAULT_MEMBERS} (live roster is 159).
  --papers <n>       Paper records. Default ${DEFAULT_PAPERS}.
  --proposals <n>    Proposals, each with an execution and two audit rows. Default ${DEFAULT_PROPOSALS}.
  --seed <n>         PRNG seed. Same seed, same database. Default 1.
  --force            Overwrite an existing file at the target path.

  Default target: ${DEFAULT_DB}
  All generated addresses use RFC-reserved domains that cannot resolve.`,
    );
    process.exit(0);
  }
  const numeric = (name: string, fallback: number): { value: number; valueAt: number } => {
    const at = args.indexOf(`--${name}`);
    if (at < 0) {
      return { value: fallback, valueAt: -1 };
    }
    const raw = args[at + 1];
    const parsed = Number(raw);
    if (raw === undefined || !Number.isFinite(parsed)) {
      throw new Error(`--${name} requires a numeric value`);
    }
    return { value: parsed, valueAt: at + 1 };
  };
  const members = numeric("members", DEFAULT_MEMBERS);
  const papers = numeric("papers", DEFAULT_PAPERS);
  const proposals = numeric("proposals", DEFAULT_PROPOSALS);
  const seed = numeric("seed", 1);
  // Each flag's value slot is excluded from the positional scan, the same way
  // adminbot-seed-member-passwords.ts does it -- otherwise `--members 160` donates "160" as the
  // database path.
  const valueSlots = new Set(
    [members.valueAt, papers.valueAt, proposals.valueAt, seed.valueAt].filter((at) => at >= 0),
  );
  const positional = args.find((arg, index) => !arg.startsWith("--") && !valueSlots.has(index));
  return {
    databasePath: positional ?? DEFAULT_DB,
    write: args.includes("--write"),
    members: Math.max(0, Math.trunc(members.value)),
    papers: Math.max(0, Math.trunc(papers.value)),
    proposals: Math.max(0, Math.trunc(proposals.value)),
    seed: Math.trunc(seed.value),
    force: args.includes("--force"),
  };
}

/**
 * Refuses to write anywhere a real database could plausibly live.
 *
 * The realistic accident is not malice, it is muscle memory: the path in every other AdminBot
 * script's docstring is `~/.openclaw/state/adminbot.sqlite`, and pasting it here would overwrite
 * the live roster with 160 fake people. The guard is a refusal rather than a prompt because this
 * runs unattended in a load rig, where a prompt is just a hang.
 */
function assertSafeTarget(databasePath: string): void {
  const resolved = path.resolve(databasePath);
  const home = process.env.HOME ?? "";
  const forbidden = [home ? path.join(home, ".openclaw") : "", path.resolve("state")].filter(
    Boolean,
  );
  for (const root of forbidden) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        `refusing to write a fixture under ${root}: that is where the real runtime state lives. ` +
          `Pass an explicit path such as ${DEFAULT_DB}.`,
      );
    }
  }
  // Anything shipped as a "runtime bundle" is someone else's real data by definition.
  if (/runtime-bundle/u.test(resolved)) {
    throw new Error(`refusing to write inside a runtime bundle path: ${resolved}`);
  }
}

function iso(random: () => number, daysBack: number): string {
  const offset = Math.floor(random() * daysBack * 24 * 60 * 60 * 1000);
  // Anchored to a fixed instant rather than Date.now(), so two runs with the same seed produce
  // byte-identical timestamps and a fixture can be diffed.
  return new Date(Date.UTC(2026, 0, 1) - offset).toISOString();
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

/**
 * One roster member.
 *
 * The name is a counter, not a generated-plausible name, and that is on purpose: a faker-style
 * roster full of "Sarah Chen" and "Miguel Torres" is indistinguishable at a glance from a real
 * export, so nobody reviewing a screenshot or a log line can tell whether they are looking at test
 * data. "Test Member 001" can only be one thing.
 */
function makeMember(index: number, random: () => number): AdminBotLabMember {
  const ordinal = String(index + 1).padStart(3, "0");
  const domain = SAFE_EMAIL_DOMAINS[index % SAFE_EMAIL_DOMAINS.length] as string;
  // Weighted rather than uniform: the live roster is overwhelmingly plain members with a handful
  // of admins, and a uniform draw would give a 160-person fixture 40 admins -- which changes how
  // many rows a privilege-filtered sweep touches, and so changes the load being measured.
  const roll = random();
  const privilege: (typeof adminBotPrivilegeLevels)[number] =
    roll < 0.05 ? "admin" : roll < 0.12 ? "external_collaborator" : roll < 0.2 ? "trial" : "member";
  const topicCount = 1 + Math.floor(random() * 3);
  const topics = Array.from({ length: topicCount }, () => pick(random, RESEARCH_TOPICS));
  return {
    id: `test-member-${ordinal}`,
    name: `Test Member ${ordinal}`,
    email: `test.member.${ordinal}@${domain}`,
    calendar_email: `test.member.${ordinal}.calendar@${domain}`,
    privilege_level: privilege,
    member_type: pick(random, MEMBER_TYPES),
    status: pick(random, adminBotMemberStatuses),
    role: "Synthetic Fixture Role",
    research_branch: pick(random, RESEARCH_BRANCHES),
    research_topics: [...new Set(topics)],
    // Off for every generated member. `receives_nudges` is the switch that decides whether
    // AdminBot will send somebody unsolicited mail, and a fixture is the last place that should
    // ever default to on -- a sweep run against this database must be incapable of addressing
    // anyone, quite apart from the addresses being unroutable.
    receives_nudges: false,
    notes: "Synthetic fixture row. Not a real person.",
    access: [{ service: "fixture", access: "none" }],
    updated_at: iso(random, 365),
  };
}

function makePaper(index: number, random: () => number, memberIds: string[]): AdminBotPaperRecord {
  const ordinal = String(index + 1).padStart(3, "0");
  const authorCount = 1 + Math.floor(random() * 4);
  const authors = Array.from({ length: authorCount }, () => {
    const memberIndex = Math.floor(random() * Math.max(1, memberIds.length));
    return `Test Member ${String(memberIndex + 1).padStart(3, "0")}`;
  });
  const createdAt = iso(random, 700);
  return {
    id: `test-paper-${ordinal}`,
    title: `Synthetic Fixture Paper ${ordinal}`,
    authors: [...new Set(authors)],
    alias: `fixture-${ordinal}`,
    current_step: pick(random, adminBotPaperSteps),
    created_at: createdAt,
    updated_at: createdAt,
  };
}

/**
 * One proposal, plus the execution row and audit trail that a real approved action leaves behind.
 *
 * Written as a set rather than as three unrelated tables because that is the invariant Task 4 has
 * to preserve under concurrency: `adminbot_executions.idempotency_key` is UNIQUE, and a queue that
 * retries a shed request must not produce a second execution row for the same key. A fixture with
 * proposals but no executions would let a broken implementation look correct.
 */
function makeProposal(
  index: number,
  random: () => number,
): {
  proposal: AdminBotStoredProposal;
  execution: AdminBotExecutionResult;
  audits: AdminBotAuditEvent[];
} {
  const ordinal = String(index + 1).padStart(3, "0");
  const id = `test-proposal-${ordinal}`;
  const idempotencyKey = `fixture-idem-${ordinal}`;
  const createdAt = iso(random, 120);
  const proposal: AdminBotStoredProposal = {
    id,
    type: "slack.send_message",
    risk_tier: pick(random, adminBotRiskTiers),
    summary: `Synthetic fixture proposal ${ordinal}`,
    rationale: "Generated by scripts/adminbot-fixture-db.ts. No real effect was ever proposed.",
    target: { channel: `#fixture-channel-${ordinal}` },
    proposed_payload: { text: `Synthetic fixture message ${ordinal}` },
    idempotency_key: idempotencyKey,
    dry_run: true,
    payload_hash: `fixturehash${ordinal}`,
    status: "executed",
    approval_requirement: { requires_approval: true, approver_roles: ["admin"], min_approvals: 1 },
    approvals: [
      {
        payload_hash: `fixturehash${ordinal}`,
        approver_role: "admin",
        approver_id: "test-member-001",
      },
    ],
    created_at: createdAt,
    updated_at: createdAt,
  };
  // dry_run true and status "simulated" throughout: a fixture must never contain a row claiming an
  // external effect actually happened, because the audit trail is what somebody reads to find out
  // whether a message was really sent.
  const execution: AdminBotExecutionResult = {
    action_id: id,
    status: "simulated",
    dry_run: true,
    idempotency_key: idempotencyKey,
    executed_at: createdAt,
  };
  const audits: AdminBotAuditEvent[] = [
    {
      id: `test-audit-${ordinal}-created`,
      action_id: id,
      type: "proposal.created",
      timestamp: createdAt,
      actor: "fixture-generator",
      details: { synthetic: true },
    },
    {
      id: `test-audit-${ordinal}-simulated`,
      action_id: id,
      type: "execution.simulated",
      timestamp: createdAt,
      actor: "fixture-generator",
      details: { synthetic: true, idempotency_key: idempotencyKey },
    },
  ];
  return { proposal, execution, audits };
}

function main(): void {
  const options = parseArgs(process.argv);
  assertSafeTarget(options.databasePath);
  const resolved = path.resolve(options.databasePath);
  const exists = fs.existsSync(resolved);

  console.log(`target:    ${resolved}`);
  console.log(`seed:      ${options.seed}`);
  console.log(`members:   ${options.members}`);
  console.log(`papers:    ${options.papers}`);
  console.log(`proposals: ${options.proposals} (each with 1 execution + 2 audit events)`);
  console.log(`existing:  ${exists ? "yes" : "no"}`);

  // Generated before the write decision so a dry run shows real sample rows rather than a promise
  // of them -- the point of the dry run is to let somebody check the data is obviously fake.
  const random = makeRandom(options.seed);
  const members = Array.from({ length: options.members }, (_, index) => makeMember(index, random));
  const memberIds = members.map((member) => member.id);
  const papers = Array.from({ length: options.papers }, (_, index) =>
    makePaper(index, random, memberIds),
  );
  const proposals = Array.from({ length: options.proposals }, (_, index) =>
    makeProposal(index, random),
  );

  console.log("\nsample rows:");
  for (const member of members.slice(0, 3)) {
    console.log(
      `  member  ${member.id}  ${member.name}  <${member.email}>  ${member.privilege_level}`,
    );
  }
  for (const paper of papers.slice(0, 2)) {
    console.log(`  paper   ${paper.id}  "${paper.title}"  step=${paper.current_step}`);
  }
  for (const { proposal } of proposals.slice(0, 2)) {
    console.log(
      `  proposal ${proposal.id}  tier=${proposal.risk_tier}  idem=${proposal.idempotency_key}`,
    );
  }

  const privilegeCounts = new Map<string, number>();
  for (const member of members) {
    privilegeCounts.set(
      member.privilege_level,
      (privilegeCounts.get(member.privilege_level) ?? 0) + 1,
    );
  }
  console.log(
    `\nprivilege mix: ${[...privilegeCounts.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([level, count]) => `${level}=${count}`)
      .join("  ")}`,
  );

  if (!options.write) {
    console.log("\nDry run. Re-run with --write to create the database.");
    return;
  }

  if (exists && !options.force) {
    throw new Error(`${resolved} already exists. Pass --force to overwrite it.`);
  }
  if (exists) {
    // WAL and shared-memory siblings too: leaving a stale -wal beside a fresh database makes
    // SQLite replay the old journal into it, which is a fixture that silently is not the one the
    // seed describes.
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${resolved}${suffix}`, { force: true });
    }
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  // The store's constructor is what creates the schema -- see the file header.
  const store = new AdminBotSqliteStore(resolved);
  try {
    for (const member of members) {
      store.saveLabMember(member);
    }
    for (const paper of papers) {
      store.savePaper(paper);
    }
    for (const { proposal, execution, audits } of proposals) {
      store.saveProposal(proposal);
      store.saveExecutionResult(execution);
      for (const audit of audits) {
        store.recordAudit(audit);
      }
    }
  } finally {
    store.close();
  }

  console.log(
    `\nWrote ${members.length} members, ${papers.length} papers, ${proposals.length} proposals ` +
      `(+${proposals.length} executions, ${proposals.length * 2} audit events) to ${resolved}`,
  );
  console.log("Every address is on an RFC-reserved domain. No production data was read.");
}

main();
