import {
  adminBotLlmDefaultMaxLocal,
  adminBotLlmDefaultMaxPublic,
  adminBotLlmDefaultMaxPublicCeiling,
  type AdminBotLlmLoadStatus,
  type AdminBotLlmNode,
  type AdminBotLlmNodeGpu,
  type AdminBotLlmSlotKind,
} from "../contracts/resilience.js";

export type LlmSlotLease = {
  kind: AdminBotLlmSlotKind;
  node?: AdminBotLlmNode;
  release: () => void;
};

export type LlmLoadRouter = {
  acquire(kind: AdminBotLlmSlotKind, signal?: AbortSignal): Promise<LlmSlotLease>;
  status(): AdminBotLlmLoadStatus;
};

export type LlmLoadRouterOptions = {
  maxLocal?: number;
  maxPublic?: number;
  nodes?: AdminBotLlmNode[];
  now?: () => number;
};

type Waiter = {
  kind: AdminBotLlmSlotKind;
  resolve: (lease: LlmSlotLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/**
 * In-process slot allocator. A non-LLM preflight: counting and waiting only.
 *
 * Public (OpenRouter-class) work is preferred whenever both pools have room. Local GPU slots
 * stay reserved for privacy classification and private tasks. When public is at cap, callers wait
 * in FIFO order instead of piling onto Aurora.
 *
 * PaperMentor can import the same module and, in a shared process, the same singleton. Across
 * processes, point both at one SQLite ledger later; the acquire/release contract stays this.
 */
export function createLlmLoadRouter(options: LlmLoadRouterOptions = {}): LlmLoadRouter {
  const maxLocal = clampPositive(options.maxLocal, adminBotLlmDefaultMaxLocal);
  const maxPublic = Math.min(
    clampPositive(options.maxPublic, adminBotLlmDefaultMaxPublic),
    adminBotLlmDefaultMaxPublicCeiling,
  );
  const nodes = options.nodes?.length ? options.nodes : defaultAuroraNode();
  let localActive = 0;
  let publicActive = 0;
  let nextNode = 0;
  const queues: Record<AdminBotLlmSlotKind, Waiter[]> = {
    local: [],
    public: [],
  };

  function releaseOnce(kind: AdminBotLlmSlotKind): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (kind === "local") {
        localActive = Math.max(0, localActive - 1);
      } else {
        publicActive = Math.max(0, publicActive - 1);
      }
      drain(kind);
    };
  }

  function tryGrant(kind: AdminBotLlmSlotKind): LlmSlotLease | undefined {
    if (kind === "local") {
      if (localActive >= maxLocal) {
        return undefined;
      }
      localActive += 1;
      const node = nodes[nextNode % nodes.length];
      nextNode += 1;
      return {
        kind,
        ...(node ? { node } : {}),
        release: releaseOnce(kind),
      };
    }
    if (publicActive >= maxPublic) {
      return undefined;
    }
    publicActive += 1;
    return {
      kind,
      release: releaseOnce(kind),
    };
  }

  function drain(kind: AdminBotLlmSlotKind): void {
    const queue = queues[kind];
    while (queue.length > 0) {
      const waiter = queue[0]!;
      const granted = tryGrant(kind);
      if (!granted) {
        return;
      }
      queue.shift();
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(granted);
    }
  }

  return {
    acquire(kind, signal) {
      if (signal?.aborted) {
        return Promise.reject(new Error("LLM queue wait was cancelled"));
      }
      const immediate = queues[kind].length === 0 ? tryGrant(kind) : undefined;
      if (immediate) {
        return Promise.resolve(immediate);
      }
      return new Promise<LlmSlotLease>((resolve, reject) => {
        const waiter: Waiter = { kind, resolve, reject, ...(signal ? { signal } : {}) };
        const onAbort = () => {
          const queue = queues[kind];
          const index = queue.indexOf(waiter);
          if (index >= 0) {
            queue.splice(index, 1);
            drain(kind);
          }
          reject(new Error("LLM queue wait was cancelled"));
        };
        if (signal) {
          waiter.onAbort = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });
        }
        queues[kind].push(waiter);
        drain(kind);
      });
    },
    status() {
      return {
        local_active: localActive,
        public_active: publicActive,
        queued: queues.local.length + queues.public.length,
        max_local: maxLocal,
        max_public: maxPublic,
        nodes,
      };
    },
  };
}

export function parseLlmNodes(raw: string | undefined): AdminBotLlmNode[] {
  if (!raw?.trim()) {
    return defaultAuroraNode();
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, baseUrl, gpu] = entry.split("|").map((part) => part.trim());
      if (!id || !baseUrl) {
        throw new Error(`ADMINBOT_LLM_NODES entry ${JSON.stringify(entry)} must be id|baseUrl|gpu`);
      }
      return { id, baseUrl, gpu: parseGpu(gpu) };
    });
}

function parseGpu(value: string | undefined): AdminBotLlmNodeGpu {
  if (value === "RTX6000" || value === "H100" || value === "other") {
    return value;
  }
  return "other";
}

function defaultAuroraNode(): AdminBotLlmNode[] {
  return [{ id: "aurora", baseUrl: "http://127.0.0.1:8000/v1", gpu: "RTX6000" }];
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

let sharedRouter: LlmLoadRouter | undefined;

/** One allocator per process so AdminBot HTTP and privacy calls share the same counters. */
export function sharedLlmLoadRouter(options?: LlmLoadRouterOptions): LlmLoadRouter {
  sharedRouter ??= createLlmLoadRouter(options);
  return sharedRouter;
}

export function resetSharedLlmLoadRouter(): void {
  sharedRouter = undefined;
}
