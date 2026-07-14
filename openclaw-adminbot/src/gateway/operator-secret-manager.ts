// Tracks pending one-shot operator secret input requests.
import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";

const RESOLVED_SECRET_ENTRY_GRACE_MS = 5_000;

export type OperatorSecretRequestPayload = {
  title: string;
  description: string;
  variableName: string;
  agentId?: string | null;
  sessionKey?: string | null;
};

export type OperatorSecretRecord = {
  id: string;
  request: OperatorSecretRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
  cancelled?: boolean;
};

type PendingEntry = {
  record: OperatorSecretRecord;
  resolve: (value: string | null) => void;
  promise: Promise<string | null>;
};

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

export class OperatorSecretManager {
  private pending = new Map<string, PendingEntry>();

  create(request: OperatorSecretRequestPayload, timeoutMs: number): OperatorSecretRecord {
    const now = Date.now();
    const expiresAtMs = resolveExpiresAtMsFromDurationMs(Math.max(1, Math.floor(timeoutMs)), {
      nowMs: now,
    });
    if (expiresAtMs === undefined) {
      throw new Error("operator secret request expiry is unavailable");
    }
    return {
      id: `secret:${randomUUID()}`,
      request,
      createdAtMs: now,
      expiresAtMs,
    };
  }

  register(record: OperatorSecretRecord, _timeoutMs: number): Promise<string | null> {
    let entry: PendingEntry;
    const promise = new Promise<string | null>((resolve) => {
      entry = {
        record,
        resolve,
        promise: null as unknown as Promise<string | null>,
      };
    });
    entry!.promise = promise;
    this.pending.set(record.id, entry!);
    return promise;
  }

  resolve(recordId: string, value: string | null): boolean {
    const pending = this.pending.get(recordId);
    if (!pending || pending.record.resolvedAtMs !== undefined) {
      return false;
    }
    pending.record.resolvedAtMs = Date.now();
    pending.record.cancelled = value === null;
    pending.resolve(value);
    const timer = setTimeout(() => {
      if (this.pending.get(recordId) === pending) {
        this.pending.delete(recordId);
      }
    }, RESOLVED_SECRET_ENTRY_GRACE_MS);
    unrefTimer(timer);
    return true;
  }

  expire(recordId: string): boolean {
    return this.resolve(recordId, null);
  }

  listPendingRecords(): OperatorSecretRecord[] {
    return Array.from(this.pending.values())
      .map((entry) => entry.record)
      .filter((record) => record.resolvedAtMs === undefined);
  }
}
