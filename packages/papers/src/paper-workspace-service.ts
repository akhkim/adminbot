import { randomUUID } from "node:crypto";
import type {
  AccessRoleName,
  AdminBotUnitOfWork,
  PaperRecord,
  PaperStageName,
  TransactionBoundary,
  UpdatePaperRecord,
} from "@adminbot/ports";

export const PAPER_STAGES: readonly PaperStageName[] = [
  "idea", "outline", "drafting", "internal_review", "submission_ready", "submitted",
  "revision", "accepted", "camera_ready", "published", "archived",
];
const STAGE_DURATIONS = [3, 4, 10, 4, 3, 1, 5, 1, 4, 2, 1] as const;

export interface PaperActor {
  readonly accountId: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly roles: readonly AccessRoleName[];
  readonly authenticationLevel: "single_factor" | "recent_reauthentication";
}

export interface PaperProjectionBody {
  readonly paper: {
    readonly id: string;
    readonly organizationId: string;
    readonly title: string;
    readonly authorIds: readonly string[];
    readonly stage: PaperStageName;
    readonly targetVenue?: string;
    readonly deadlineAt?: string;
    readonly sourceUri?: string;
    readonly topicTags: readonly string[];
    readonly version: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly authorNames: readonly string[];
  readonly timeline: {
    readonly progressPercent: number;
    readonly totalEstimatedBusinessDays: number;
    readonly items: readonly {
      readonly stage: PaperStageName;
      readonly label: string;
      readonly offsetStartBusinessDay: number;
      readonly durationBusinessDays: number;
      readonly state: "complete" | "current" | "upcoming";
    }[];
  };
}

export interface PaperWorkspaceBody {
  readonly papers: readonly PaperProjectionBody[];
  readonly nudges: readonly PaperNudgeBody[];
  readonly viewerPersonId: string;
  readonly viewerRoles: readonly string[];
}

interface PaperNudgeBody {
  readonly paperId: string;
  readonly title: string;
  readonly stage: PaperStageName;
  readonly dueAt: string;
  readonly recipientIds: readonly string[];
  readonly recipientNames: readonly string[];
  readonly kind: "author_nudge" | "administrator_escalation";
  readonly message: string;
}

type ErrorCode =
  | "conflict"
  | "not_authenticated"
  | "not_authorized"
  | "not_found"
  | "payload_invalid";
type ErrorResult = Readonly<{
  ok: false;
  status: 400 | 401 | 403 | 404 | 409;
  body: { readonly code: ErrorCode; readonly message: string; readonly retryable: false };
}>;
export type PaperCommandResult =
  | Readonly<{ ok: true; status: 200 | 201; body?: PaperProjectionBody | PaperWorkspaceBody }>
  | ErrorResult;

type PaperFields = {
  title?: string;
  authorIds?: readonly string[];
  stage?: PaperStageName;
  targetVenue?: string | null;
  deadlineAt?: Date | null;
  sourceUri?: string | null;
  topicTags?: readonly string[];
};

export class PaperWorkspaceService {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly options: {
      readonly transactions: TransactionBoundary;
      readonly organizationId: string;
      readonly now?: () => Date;
      readonly createId?: () => string;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async list(actor: PaperActor | undefined): Promise<PaperCommandResult> {
    const denied = authorizeRead(actor, this.options.organizationId);
    if (denied !== undefined) return denied;
    if (actor === undefined) throw new Error("authorization invariant violated");
    const papers = await this.options.transactions.read((unit) =>
      requirePaperRepository(unit).list(this.options.organizationId),
    );
    return {
      ok: true,
      status: 200,
      body: {
        papers: papers.map(projectPaper),
        nudges: actor.roles.includes("administrator") ? buildNudges(papers, this.now()) : [],
        viewerPersonId: actor.personId,
        viewerRoles: actor.roles,
      },
    };
  }

  async create(actor: PaperActor | undefined, input: unknown): Promise<PaperCommandResult> {
    const denied = authorizeRead(actor, this.options.organizationId);
    if (denied !== undefined) return denied;
    if (actor === undefined) throw new Error("authorization invariant violated");
    const writeDenied = authorizeWrite(actor);
    if (writeDenied !== undefined) return writeDenied;
    const parsed = validateFields(input);
    if (!parsed.ok) return parsed.error;
    if (parsed.value.title === undefined || parsed.value.authorIds === undefined) {
      return failure(400, "payload_invalid", "title and authorIds are required");
    }
    if (!actor.roles.includes("administrator") && !parsed.value.authorIds.includes(actor.personId)) {
      return failure(403, "not_authorized", "a member may only create a paper they author");
    }
    const now = this.now();
    const id = this.createId();
    const created = await this.options.transactions.write(async (unit) => {
      const paper = await requirePaperRepository(unit).create({
        id,
        organizationId: this.options.organizationId,
        now,
        title: parsed.value.title as string,
        authorIds: parsed.value.authorIds as readonly string[],
        stage: parsed.value.stage ?? "idea",
        topicTags: parsed.value.topicTags ?? [],
        ...(parsed.value.targetVenue == null ? {} : { targetVenue: parsed.value.targetVenue }),
        ...(parsed.value.deadlineAt == null ? {} : { deadlineAt: parsed.value.deadlineAt }),
        ...(parsed.value.sourceUri == null ? {} : { sourceUri: parsed.value.sourceUri }),
      });
      if (paper === "authors_not_found") return paper;
      await recordMutation(unit, this.createId, actor, paper, "created", now);
      return paper;
    });
    return created === "authors_not_found"
      ? failure(400, "payload_invalid", "one or more authors do not exist")
      : { ok: true, status: 201, body: projectPaper(created) };
  }

  async update(
    actor: PaperActor | undefined,
    paperId: string,
    input: unknown,
  ): Promise<PaperCommandResult> {
    const denied = authorizeRead(actor, this.options.organizationId);
    if (denied !== undefined) return denied;
    if (actor === undefined) throw new Error("authorization invariant violated");
    const writeDenied = authorizeWrite(actor);
    if (writeDenied !== undefined) return writeDenied;
    if (!isUuid(paperId)) return failure(404, "not_found", "paper not found");
    if (!isRecord(input) || input.paperId !== paperId || !positiveInt(input.expectedVersion)) {
      return failure(400, "payload_invalid", "paperId and expectedVersion are required");
    }
    const parsed = validateFields(input);
    if (!parsed.ok) return parsed.error;
    const existing = await this.options.transactions.read((unit) =>
      requirePaperRepository(unit).find(this.options.organizationId, paperId),
    );
    if (existing === undefined) return failure(404, "not_found", "paper not found");
    const administrator = actor.roles.includes("administrator");
    if (!administrator && !existing.authorIds.includes(actor.personId)) {
      return failure(403, "not_authorized", "only an author or administrator may edit this paper");
    }
    if (!administrator && parsed.value.authorIds !== undefined) {
      return failure(403, "not_authorized", "only an administrator may change authorship");
    }
    const now = this.now();
    const update: UpdatePaperRecord = {
      id: paperId,
      organizationId: this.options.organizationId,
      expectedVersion: input.expectedVersion,
      now,
      ...parsed.value,
    };
    const updated = await this.options.transactions.write(async (unit) => {
      const paper = await requirePaperRepository(unit).update(update);
      if (typeof paper === "string") return paper;
      await recordMutation(unit, this.createId, actor, paper, "updated", now);
      return paper;
    });
    if (updated === "not_found") return failure(404, "not_found", "paper not found");
    if (updated === "conflict") {
      return failure(409, "conflict", "paper changed; refresh and try again");
    }
    if (updated === "authors_not_found") {
      return failure(400, "payload_invalid", "one or more authors do not exist");
    }
    return { ok: true, status: 200, body: projectPaper(updated) };
  }

  async delete(
    actor: PaperActor | undefined,
    paperId: string,
    input: unknown,
  ): Promise<PaperCommandResult> {
    if (actor === undefined) return failure(401, "not_authenticated", "authentication required");
    if (
      actor.organizationId !== this.options.organizationId ||
      !actor.roles.includes("administrator")
    ) {
      return failure(403, "not_authorized", "administrator role required");
    }
    if (actor.authenticationLevel !== "recent_reauthentication") {
      return failure(403, "not_authorized", "recent reauthentication required");
    }
    if (
      !isRecord(input) ||
      Object.keys(input).some((key) => key !== "paperId" && key !== "expectedVersion") ||
      input.paperId !== paperId ||
      !positiveInt(input.expectedVersion)
    ) {
      return failure(400, "payload_invalid", "paperId and expectedVersion are required");
    }
    const now = this.now();
    const deleted = await this.options.transactions.write(async (unit) => {
      const result = await requirePaperRepository(unit).delete(
        this.options.organizationId,
        paperId,
        input.expectedVersion as number,
      );
      if (result !== "deleted") return result;
      await unit.audit.append({
        id: this.createId(), organizationId: this.options.organizationId,
        eventType: "papers.paper_deleted", actorId: actor.accountId, subjectId: paperId,
        safeDetails: { version: input.expectedVersion as number }, occurredAt: now,
      });
      await unit.outbox.enqueue({
        id: this.createId(), organizationId: this.options.organizationId,
        eventType: "papers.paper_deleted", aggregateType: "paper", aggregateId: paperId,
        payload: { paperId, version: input.expectedVersion as number }, availableAt: now,
      });
      return result;
    });
    if (deleted === "not_found") return failure(404, "not_found", "paper not found");
    if (deleted === "conflict") {
      return failure(409, "conflict", "paper changed; refresh and try again");
    }
    return { ok: true, status: 200 };
  }
}

async function recordMutation(
  unit: AdminBotUnitOfWork,
  createId: () => string,
  actor: PaperActor,
  paper: PaperRecord,
  action: "created" | "updated",
  now: Date,
): Promise<void> {
  await unit.audit.append({
    id: createId(), organizationId: paper.organizationId,
    eventType: `papers.paper_${action}`, actorId: actor.accountId, subjectId: paper.id,
    safeDetails: { version: paper.version, stage: paper.stage }, occurredAt: now,
  });
  await unit.outbox.enqueue({
    id: createId(), organizationId: paper.organizationId,
    eventType: `papers.paper_${action}`, aggregateType: "paper", aggregateId: paper.id,
    payload: { paperId: paper.id, version: paper.version }, availableAt: now,
  });
}

export function projectPaper(record: PaperRecord): PaperProjectionBody {
  let offset = 0;
  const currentIndex = PAPER_STAGES.indexOf(record.stage);
  const total = STAGE_DURATIONS.reduce((sum, value) => sum + value, 0);
  return {
    paper: {
      id: record.id, organizationId: record.organizationId, title: record.title,
      authorIds: record.authorIds, stage: record.stage, topicTags: record.topicTags,
      version: record.version, createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      ...(record.targetVenue === undefined ? {} : { targetVenue: record.targetVenue }),
      ...(record.deadlineAt === undefined ? {} : { deadlineAt: record.deadlineAt.toISOString() }),
      ...(record.sourceUri === undefined ? {} : { sourceUri: record.sourceUri }),
    },
    authorNames: record.authorNames,
    timeline: {
      progressPercent: Math.round((currentIndex / (PAPER_STAGES.length - 1)) * 100),
      totalEstimatedBusinessDays: total,
      items: PAPER_STAGES.map((stage, index) => {
        const start = offset;
        offset += STAGE_DURATIONS[index] ?? 1;
        return {
          stage, label: friendly(stage), offsetStartBusinessDay: start,
          durationBusinessDays: STAGE_DURATIONS[index] ?? 1,
          state: index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming",
        };
      }),
    },
  };
}

function buildNudges(papers: readonly PaperRecord[], now: Date): readonly PaperNudgeBody[] {
  const terminal = new Set<PaperStageName>(["published", "archived"]);
  return papers.flatMap((paper) => {
    if (paper.deadlineAt === undefined || terminal.has(paper.stage)) return [];
    const hours = (paper.deadlineAt.getTime() - now.getTime()) / 3_600_000;
    if (hours > 24 * 30) return [];
    const overdue = hours < 0;
    return [{
      paperId: paper.id, title: paper.title, stage: paper.stage,
      dueAt: paper.deadlineAt.toISOString(), recipientIds: paper.authorIds,
      recipientNames: paper.authorNames,
      kind: overdue ? "administrator_escalation" as const : "author_nudge" as const,
      message: overdue
        ? `${paper.title} is past its recorded deadline and still at ${friendly(paper.stage)}.`
        : `${paper.title} is due in ${Math.max(1, Math.ceil(hours / 24))} day(s); current stage: ${friendly(paper.stage)}.`,
    }];
  });
}

function validateFields(input: unknown):
  | { readonly ok: true; readonly value: PaperFields }
  | { readonly ok: false; readonly error: ErrorResult } {
  if (!isRecord(input)) {
    return { ok: false, error: failure(400, "payload_invalid", "request must be an object") };
  }
  const allowed = new Set([
    "paperId", "expectedVersion", "title", "authorIds", "stage", "targetVenue",
    "deadlineAt", "sourceUri", "topicTags",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return { ok: false, error: failure(400, "payload_invalid", "request contains an unsupported field") };
  }
  const value: PaperFields = {};
  if (input.title !== undefined) {
    if (
      typeof input.title !== "string" ||
      input.title.trim().length < 1 ||
      input.title.trim().length > 500
    ) return { ok: false, error: failure(400, "payload_invalid", "title must be 1-500 characters") };
    value.title = input.title.trim();
  }
  if (input.authorIds !== undefined) {
    const ids = stringList(input.authorIds, 50, true);
    if (ids === undefined || ids.some((id) => !isUuid(id))) {
      return { ok: false, error: failure(400, "payload_invalid", "authorIds must contain valid person IDs") };
    }
    value.authorIds = ids;
  }
  if (input.stage !== undefined) {
    if (!PAPER_STAGES.includes(input.stage as PaperStageName)) {
      return { ok: false, error: failure(400, "payload_invalid", "stage is invalid") };
    }
    value.stage = input.stage as PaperStageName;
  }
  const target = optionalText(input.targetVenue, 240);
  if (target === false) return { ok: false, error: failure(400, "payload_invalid", "targetVenue is invalid") };
  if (target !== undefined) value.targetVenue = target;
  const source = optionalText(input.sourceUri, 2_048);
  if (source === false) return { ok: false, error: failure(400, "payload_invalid", "sourceUri is invalid") };
  if (source !== undefined) {
    if (source !== null) {
      try { new URL(source); } catch {
        return { ok: false, error: failure(400, "payload_invalid", "sourceUri must be a URL") };
      }
    }
    value.sourceUri = source;
  }
  if (input.deadlineAt !== undefined) {
    if (input.deadlineAt === null || input.deadlineAt === "") value.deadlineAt = null;
    else if (typeof input.deadlineAt !== "string" || !Number.isFinite(Date.parse(input.deadlineAt))) {
      return { ok: false, error: failure(400, "payload_invalid", "deadlineAt must be an ISO timestamp") };
    } else value.deadlineAt = new Date(input.deadlineAt);
  }
  if (input.topicTags !== undefined) {
    const tags = stringList(input.topicTags, 30, false);
    if (tags === undefined) {
      return { ok: false, error: failure(400, "payload_invalid", "topicTags must be strings") };
    }
    value.topicTags = tags;
  }
  return { ok: true, value };
}

function authorizeRead(actor: PaperActor | undefined, organizationId: string): ErrorResult | undefined {
  if (actor === undefined) return failure(401, "not_authenticated", "authentication required");
  const canRead = actor.roles.some((role) =>
    role === "external_collaborator" || role === "member" || role === "administrator",
  );
  if (actor.organizationId !== organizationId || !canRead) {
    return failure(403, "not_authorized", "workspace membership required");
  }
  return undefined;
}

function authorizeWrite(actor: PaperActor): ErrorResult | undefined {
  return actor.roles.some((role) => role === "member" || role === "administrator")
    ? undefined
    : failure(403, "not_authorized", "member role required");
}

function requirePaperRepository(unit: AdminBotUnitOfWork) {
  if (unit.papers === undefined) throw new Error("paper repository is not configured");
  return unit.papers;
}

function optionalText(value: unknown, maximum: number): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maximum) return false;
  return value.trim();
}
function stringList(value: unknown, maximum: number, required: boolean): readonly string[] | undefined {
  if (
    !Array.isArray(value) || value.length > maximum || (required && value.length === 0) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0 || item.trim().length > 200)
  ) return undefined;
  return [...new Set(value.map((item) => (item as string).trim()))];
}
function failure(status: ErrorResult["status"], code: ErrorCode, message: string): ErrorResult {
  return { ok: false, status, body: { code, message, retryable: false } };
}
function friendly(value: string): string {
  return value.split("_").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}
function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
