import { randomUUID } from "node:crypto";
import type {
  AccessRoleName,
  AdminBotUnitOfWork,
  AvailabilityEntryRecord,
  AvailabilityPlanRecord,
  TransactionBoundary,
} from "@adminbot/ports";

export interface AvailabilityActor {
  readonly accountId: string;
  readonly organizationId: string;
  readonly personId: string;
  readonly roles: readonly AccessRoleName[];
}

type ErrorResult = Readonly<{
  ok: false;
  status: 400 | 401 | 403 | 404 | 409;
  body: { readonly code: "conflict" | "not_authenticated" | "not_authorized" | "not_found" | "payload_invalid"; readonly message: string; readonly retryable: false };
}>;
export type AvailabilityCommandResult =
  | Readonly<{ ok: true; status: 200; body: AvailabilityWorkspaceBody }>
  | ErrorResult;

interface AvailabilityWorkspaceBody {
  readonly viewerPersonId: string;
  readonly viewerRoles: readonly string[];
  readonly ownPlan: AvailabilityPlanBody;
  readonly visiblePlans: readonly AvailabilityPlanBody[];
  readonly summaries: readonly AvailabilitySummaryBody[];
  readonly asOf: string;
}

interface AvailabilityPlanBody {
  readonly id: string; readonly organizationId: string; readonly personId: string;
  readonly personName: string; readonly timeZone: string; readonly defaultWeeklyHours: number;
  readonly entries: readonly AvailabilityEntryBody[]; readonly version: number;
  readonly createdAt: string; readonly updatedAt: string;
}
interface AvailabilityEntryBody {
  readonly id: string; readonly kind: AvailabilityEntryRecord["kind"];
  readonly startsOn: string; readonly endsOn: string; readonly hoursPerWeek?: number;
  readonly label?: string; readonly color?: string; readonly timeOffAvailability?: "none" | "partial";
  readonly privateReason?: string; readonly supportingUri?: string;
  readonly visibility: AvailabilityEntryRecord["visibility"];
  readonly source: "manual" | "imported"; readonly confirmedAt: string;
}
interface AvailabilitySummaryBody {
  readonly personId: string; readonly personName: string; readonly allocatedHours: number;
  readonly openHours: number; readonly away: "none" | "partial" | "full";
  readonly confirmedAt?: string; readonly stale: boolean;
}

export class AvailabilityWorkspaceService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  constructor(private readonly options: { readonly transactions: TransactionBoundary; readonly organizationId: string; readonly now?: () => Date; readonly createId?: () => string }) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async get(actor: AvailabilityActor | undefined): Promise<AvailabilityCommandResult> {
    const denied = authorize(actor, this.options.organizationId);
    if (denied !== undefined) return denied;
    if (actor === undefined) throw new Error("authorization invariant violated");
    const now = this.now();
    let own = await this.options.transactions.read((unit) => repository(unit).find(this.options.organizationId, actor.personId));
    if (own === undefined) {
      const ensured = await this.options.transactions.write((unit) => repository(unit).ensure({ id: this.createId(), organizationId: this.options.organizationId, personId: actor.personId, timeZone: "UTC", defaultWeeklyHours: 40, now }));
      if (ensured === "person_not_found") return failure(404, "not_found", "member not found");
      own = ensured;
    }
    const plans = await this.options.transactions.read((unit) => repository(unit).list(this.options.organizationId));
    const people = await this.options.transactions.read((unit) => repository(unit).listPeople(this.options.organizationId));
    return { ok: true, status: 200, body: projectWorkspace(actor, own, plans, people, now) };
  }

  async replace(actor: AvailabilityActor | undefined, input: unknown): Promise<AvailabilityCommandResult> {
    const denied = authorize(actor, this.options.organizationId);
    if (denied !== undefined) return denied;
    if (actor === undefined) throw new Error("authorization invariant violated");
    const parsed = validateCommand(input);
    if (!parsed.ok) return parsed.error;
    const existing = await this.options.transactions.read((unit) => repository(unit).find(this.options.organizationId, actor.personId));
    if (existing === undefined || existing.id !== parsed.value.planId) return failure(404, "not_found", "availability plan not found");
    if (!importedEntriesUnchanged(existing.entries, parsed.value.entries)) {
      return failure(400, "payload_invalid", "imported entries require an explicit reconciliation workflow");
    }
    const now = this.now();
    const updated = await this.options.transactions.write(async (unit) => {
      const result = await repository(unit).replace({
        id: parsed.value.planId, organizationId: this.options.organizationId,
        personId: actor.personId, expectedVersion: parsed.value.expectedVersion,
        timeZone: parsed.value.timeZone, defaultWeeklyHours: parsed.value.defaultWeeklyHours,
        entries: parsed.value.entries.map((entry) => ({
          ...entry,
          confirmedAt: entry.source === "imported"
            ? existing.entries.find((candidate) => candidate.id === entry.id)?.confirmedAt ?? now
            : now,
        })),
        now,
      });
      if (typeof result === "string") return result;
      await unit.audit.append({ id: this.createId(), organizationId: this.options.organizationId, eventType: "availability.plan_replaced", actorId: actor.accountId, subjectId: actor.personId, safeDetails: { version: result.version, entries: result.entries.length }, occurredAt: now });
      await unit.outbox.enqueue({ id: this.createId(), organizationId: this.options.organizationId, eventType: "availability.plan_replaced", aggregateType: "availability_plan", aggregateId: result.id, payload: { planId: result.id, personId: actor.personId, version: result.version }, availableAt: now });
      return result;
    });
    if (updated === "not_found") return failure(404, "not_found", "availability plan not found");
    if (updated === "conflict") return failure(409, "conflict", "availability changed; refresh and try again");
    const plans = await this.options.transactions.read((unit) => repository(unit).list(this.options.organizationId));
    const people = await this.options.transactions.read((unit) => repository(unit).listPeople(this.options.organizationId));
    return { ok: true, status: 200, body: projectWorkspace(actor, updated, plans, people, now) };
  }
}

function projectWorkspace(actor: AvailabilityActor, own: AvailabilityPlanRecord, plans: readonly AvailabilityPlanRecord[], people: readonly { readonly personId: string; readonly personName: string }[], now: Date): AvailabilityWorkspaceBody {
  const administrator = actor.roles.includes("administrator");
  return {
    viewerPersonId: actor.personId, viewerRoles: actor.roles, ownPlan: projectPlan(own, true),
    visiblePlans: plans.map((plan) => projectPlan(plan, administrator || plan.personId === actor.personId)),
    summaries: people.map((person) => {
      const plan = plans.find((candidate) => candidate.personId === person.personId);
      return plan === undefined
        ? { personId: person.personId, personName: person.personName, allocatedHours: 0, openHours: 0, away: "none" as const, stale: true }
        : summarize(plan, now);
    }), asOf: now.toISOString(),
  };
}

function projectPlan(plan: AvailabilityPlanRecord, full: boolean): AvailabilityPlanBody {
  return {
    id: plan.id, organizationId: plan.organizationId, personId: plan.personId,
    personName: plan.personName, timeZone: plan.timeZone, defaultWeeklyHours: plan.defaultWeeklyHours,
    version: plan.version, createdAt: plan.createdAt.toISOString(), updatedAt: plan.updatedAt.toISOString(),
    entries: plan.entries.filter((entry) => full || entry.visibility !== "administrators").map((entry) => ({
      id: entry.id, kind: entry.kind, startsOn: entry.startsOn, endsOn: entry.endsOn,
      visibility: entry.visibility, source: entry.source, confirmedAt: entry.confirmedAt.toISOString(),
      ...(entry.hoursPerWeek === undefined ? {} : { hoursPerWeek: entry.hoursPerWeek }),
      ...(!full && entry.kind === "time_off" ? {} : entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.color === undefined ? {} : { color: entry.color }),
      ...(entry.timeOffAvailability === undefined ? {} : { timeOffAvailability: entry.timeOffAvailability }),
      ...(full && entry.privateReason !== undefined ? { privateReason: entry.privateReason } : {}),
      ...(full && entry.supportingUri !== undefined ? { supportingUri: entry.supportingUri } : {}),
    })),
  };
}

function summarize(plan: AvailabilityPlanRecord, now: Date): AvailabilitySummaryBody {
  const day = now.toISOString().slice(0, 10);
  const active = plan.entries.filter((entry) => entry.startsOn <= day && entry.endsOn >= day);
  const timeOff = active.filter((entry) => entry.kind === "time_off");
  const away = timeOff.some((entry) => entry.timeOffAvailability === "none") ? "full" as const : timeOff.length > 0 ? "partial" as const : "none" as const;
  const confirmedAt = plan.entries.map((entry) => entry.confirmedAt).toSorted((a, b) => b.getTime() - a.getTime())[0];
  const fullAway = away === "full";
  return {
    personId: plan.personId, personName: plan.personName,
    allocatedHours: fullAway ? 0 : sumHours(active, "allocation"),
    openHours: fullAway ? 0 : sumHours(active, "open_capacity"), away,
    ...(confirmedAt === undefined ? {} : { confirmedAt: confirmedAt.toISOString() }),
    stale: confirmedAt === undefined || now.getTime() - confirmedAt.getTime() > 30 * 86_400_000,
  };
}
function sumHours(entries: readonly AvailabilityEntryRecord[], kind: AvailabilityEntryRecord["kind"]): number { return entries.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + (entry.hoursPerWeek ?? 0), 0); }

function importedEntriesUnchanged(existing: readonly AvailabilityEntryRecord[], proposed: readonly Omit<AvailabilityEntryRecord, "planId" | "confirmedAt">[]): boolean {
  const imported = existing.filter((entry) => entry.source === "imported");
  return imported.length === proposed.filter((entry) => entry.source === "imported").length && imported.every((entry) => {
    const next = proposed.find((candidate) => candidate.id === entry.id);
    if (next === undefined) return false;
    return entry.kind === next.kind && entry.startsOn === next.startsOn && entry.endsOn === next.endsOn && entry.hoursPerWeek === next.hoursPerWeek && entry.label === next.label && entry.color === next.color && entry.timeOffAvailability === next.timeOffAvailability && entry.privateReason === next.privateReason && entry.supportingUri === next.supportingUri && entry.visibility === next.visibility;
  });
}

type ParsedCommand = { planId: string; expectedVersion: number; timeZone: string; defaultWeeklyHours: number; entries: readonly Omit<AvailabilityEntryRecord, "planId" | "confirmedAt">[] };
function validateCommand(input: unknown): { ok: true; value: ParsedCommand } | { ok: false; error: ErrorResult } {
  if (!record(input) || !uuid(input.planId) || !positiveInt(input.expectedVersion) || typeof input.timeZone !== "string" || !validTimeZone(input.timeZone) || typeof input.defaultWeeklyHours !== "number" || input.defaultWeeklyHours < 1 || input.defaultWeeklyHours > 168 || !Array.isArray(input.entries) || input.entries.length > 200) return { ok: false, error: failure(400, "payload_invalid", "plan settings or entries are invalid") };
  const entries: Omit<AvailabilityEntryRecord, "planId" | "confirmedAt">[] = [];
  const ids = new Set<string>();
  for (const raw of input.entries) {
    const parsed = validateEntry(raw);
    if (parsed === undefined || ids.has(parsed.id)) return { ok: false, error: failure(400, "payload_invalid", "availability entry is invalid") };
    ids.add(parsed.id); entries.push(parsed);
  }
  return { ok: true, value: { planId: input.planId, expectedVersion: input.expectedVersion, timeZone: input.timeZone, defaultWeeklyHours: input.defaultWeeklyHours, entries } };
}
function validateEntry(value: unknown): Omit<AvailabilityEntryRecord, "planId" | "confirmedAt"> | undefined {
  if (!record(value) || !uuid(value.id) || !kind(value.kind) || !plainDate(value.startsOn) || !plainDate(value.endsOn) || value.startsOn > value.endsOn || !visibility(value.visibility) || (value.source !== "manual" && value.source !== "imported")) return undefined;
  const hoursRequired = value.kind !== "time_off";
  if ((hoursRequired && (typeof value.hoursPerWeek !== "number" || value.hoursPerWeek < 0 || value.hoursPerWeek > 168)) || (!hoursRequired && value.hoursPerWeek !== undefined)) return undefined;
  if (value.kind === "time_off" && value.timeOffAvailability !== "none" && value.timeOffAvailability !== "partial") return undefined;
  const label = text(value.label, 200); const color = text(value.color, 7); const reason = text(value.privateReason, 2_000); const uri = text(value.supportingUri, 2_048);
  if (label === false || color === false || reason === false || uri === false || (color !== undefined && !/^#[0-9a-f]{6}$/iu.test(color)) || (uri !== undefined && !httpUrl(uri))) return undefined;
  return { id: value.id, kind: value.kind, startsOn: value.startsOn, endsOn: value.endsOn, visibility: value.visibility, source: value.source,
    ...(hoursRequired ? { hoursPerWeek: value.hoursPerWeek as number } : {}), ...(label === undefined ? {} : { label }), ...(color === undefined ? {} : { color }),
    ...(value.kind === "time_off" ? { timeOffAvailability: value.timeOffAvailability as "none" | "partial" } : {}), ...(reason === undefined ? {} : { privateReason: reason }), ...(uri === undefined ? {} : { supportingUri: uri }) };
}
function authorize(actor: AvailabilityActor | undefined, organizationId: string): ErrorResult | undefined { if (actor === undefined) return failure(401, "not_authenticated", "authentication required"); return actor.organizationId === organizationId && actor.roles.some((role) => role === "member" || role === "administrator") ? undefined : failure(403, "not_authorized", "member role required"); }
function repository(unit: AdminBotUnitOfWork) { if (unit.availability === undefined) throw new Error("availability repository is not configured"); return unit.availability; }
function failure(status: ErrorResult["status"], code: ErrorResult["body"]["code"], message: string): ErrorResult { return { ok: false, status, body: { code, message, retryable: false } }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }
function positiveInt(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function kind(value: unknown): value is AvailabilityEntryRecord["kind"] { return value === "allocation" || value === "open_capacity" || value === "time_off" || value === "tentative"; }
function visibility(value: unknown): value is AvailabilityEntryRecord["visibility"] { return value === "administrators" || value === "members" || value === "summary_only"; }
function plainDate(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }
function validTimeZone(value: string): boolean { if (value.length < 1 || value.length > 100) return false; try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }
function text(value: unknown, maximum: number): string | undefined | false { if (value === undefined || value === null || value === "") return undefined; return typeof value === "string" && value.trim().length <= maximum ? value.trim() : false; }
function httpUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; } }
