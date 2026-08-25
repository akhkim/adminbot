import {
  deadlineProposalEntryTypes,
  validateDeadlineProposalInput,
  type DeadlineProposalInput,
  type DeadlineProposalView,
} from "../../../../../extensions/adminbot/src/contracts/deadline-proposals.js";
import type { UiSettings } from "../../storage.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import type { DeadlineVenue } from "./deadlines.ts";

export const DEADLINE_PROPOSAL_ENTRY_TYPES = deadlineProposalEntryTypes;
export const validateDeadlineProposal = validateDeadlineProposalInput;
export type { DeadlineProposalInput };
export type DeadlineProposal = DeadlineProposalView;

export interface DeadlineProposalStore {
  list(): Promise<DeadlineProposal[]>;
  listPublished(): Promise<DeadlineVenue[]>;
  submit(input: DeadlineProposalInput, idempotencyKey: string): Promise<DeadlineProposal>;
  revise(proposalId: string, input: DeadlineProposalInput): Promise<DeadlineProposal>;
  decide(proposal: DeadlineProposal, decision: "published" | "rejected"): Promise<DeadlineProposal>;
}

type FetchLike = typeof fetch;
const storesByBaseUrl = new Map<string, AdminBotDeadlineProposalStore>();

export function deadlineProposalStoreFor(
  settings?: Pick<UiSettings, "adminBotUrl"> | null,
): AdminBotDeadlineProposalStore {
  const baseUrl = resolveAdminBotBaseUrl(settings);
  const existing = storesByBaseUrl.get(baseUrl);
  if (existing) {
    return existing;
  }
  const store = new AdminBotDeadlineProposalStore(() => baseUrl);
  storesByBaseUrl.set(baseUrl, store);
  return store;
}

export class AdminBotDeadlineProposalStore implements DeadlineProposalStore {
  constructor(
    private readonly baseUrl: () => string = () => resolveAdminBotBaseUrl(),
    private readonly sessionToken: () => string | undefined = () =>
      loadStoredMemberSession()?.sessionToken,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async list(): Promise<DeadlineProposal[]> {
    const body = await this.request("/deadline-proposals", { method: "GET", authenticated: true });
    return (body as { proposals?: DeadlineProposal[] }).proposals ?? [];
  }

  async listPublished(): Promise<DeadlineVenue[]> {
    const body = await this.request("/deadlines/venues.json", { method: "GET" });
    return (body as { items?: DeadlineVenue[] }).items ?? [];
  }

  async submit(input: DeadlineProposalInput, idempotencyKey: string): Promise<DeadlineProposal> {
    return (await this.request("/deadline-proposals", {
      method: "POST",
      authenticated: true,
      body: input,
      headers: { "Idempotency-Key": idempotencyKey },
    })) as DeadlineProposal;
  }

  async revise(proposalId: string, input: DeadlineProposalInput): Promise<DeadlineProposal> {
    return (await this.request(`/deadline-proposals/${encodeURIComponent(proposalId)}/revisions`, {
      method: "POST",
      authenticated: true,
      body: input,
    })) as DeadlineProposal;
  }

  async decide(
    proposal: DeadlineProposal,
    decision: "published" | "rejected",
  ): Promise<DeadlineProposal> {
    const path = `/deadline-proposals/${encodeURIComponent(proposal.id)}/${
      decision === "published" ? "publish" : "reject"
    }`;
    return (await this.request(path, {
      method: "POST",
      authenticated: true,
      body: decision === "published" ? { payload_hash: proposal.payload_hash } : {},
    })) as DeadlineProposal;
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST";
      authenticated?: boolean;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<unknown> {
    const token = options.authenticated ? this.sessionToken() : undefined;
    if (options.authenticated && !token) {
      throw new Error("Sign in to use deadline proposals.");
    }
    const response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
      method: options.method,
      headers: {
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      throw new Error(body?.error?.message ?? `Deadline service returned ${response.status}.`);
    }
    return body;
  }
}
