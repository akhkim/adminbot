// Control Ui Mock Dev script supports OpenClaw repository automation.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../src/gateway/control-ui-contract.js";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  type ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import {
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "../ui/vite.config.ts";

type CliOptions = {
  allowedHosts: string[];
  host: string;
  port: number;
};

type SessionListOptions = {
  hasMore: boolean;
  nextOffset: number | null;
  offset?: number;
  totalCount: number;
};

const SESSION_PAGE_SIZE = 50;
const TOTAL_MOCK_SESSIONS = 650;
const TOTAL_TELEGRAM_SESSIONS = 180;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(repoRoot, "ui");

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { allowedHosts: [], host: "127.0.0.1", port: 5187 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--allowed-host") {
      const allowedHost = args[++i]?.trim();
      if (allowedHost) {
        options.allowedHosts.push(allowedHost);
      }
    } else if (arg.startsWith("--allowed-host=")) {
      const allowedHost = arg.slice("--allowed-host=".length).trim();
      if (allowedHost) {
        options.allowedHosts.push(allowedHost);
      }
    } else if (arg === "--host") {
      options.host = args[++i] ?? options.host;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length) || options.host;
    } else if (arg === "--port") {
      options.port = parsePort(args[++i], options.port);
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length), options.port);
    }
  }
  return options;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options: { model?: string; modelProvider?: string } = {},
) {
  return {
    contextTokens: null,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: options.model ?? "gpt-5.5",
    modelProvider: options.modelProvider ?? "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
  };
}

function sessionsListResponse(sessions: unknown[], options: SessionListOptions) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    hasMore: options.hasMore,
    limitApplied: 50,
    nextOffset: options.nextOffset,
    offset: options.offset ?? 0,
    path: "",
    sessions,
    totalCount: options.totalCount,
    ts: Date.now(),
  };
}

function pagedSessionsListResponse(sessions: unknown[], offset: number) {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  const page = sessions.slice(normalizedOffset, normalizedOffset + SESSION_PAGE_SIZE);
  const nextOffset = normalizedOffset + SESSION_PAGE_SIZE;
  return sessionsListResponse(page, {
    hasMore: nextOffset < sessions.length,
    nextOffset: nextOffset < sessions.length ? nextOffset : null,
    offset: normalizedOffset,
    totalCount: sessions.length,
  });
}

function buildSessionRows(params: {
  baseTime: number;
  count: number;
  keyPrefix: string;
  labelPrefix: string;
  model?: string;
  modelProvider?: string;
}) {
  return Array.from({ length: params.count }, (_value, index) => {
    const ordinal = index + 1;
    const padded = String(ordinal).padStart(3, "0");
    return sessionRow(
      `agent:${params.keyPrefix}-${padded}`,
      `${params.labelPrefix} ${padded}`,
      params.baseTime - ordinal * 60_000,
      { model: params.model, modelProvider: params.modelProvider },
    );
  });
}

function buildSessionListCases(
  sessions: unknown[],
  matchBase: Record<string, unknown> = {},
): Array<{ match: Record<string, unknown>; response: unknown }> {
  const cases: Array<{ match: Record<string, unknown>; response: unknown }> = [];
  for (let offset = SESSION_PAGE_SIZE; offset < sessions.length; offset += SESSION_PAGE_SIZE) {
    cases.push({
      match: { ...matchBase, offset },
      response: pagedSessionsListResponse(sessions, offset),
    });
  }
  cases.push({
    match: matchBase,
    response: pagedSessionsListResponse(sessions, 0),
  });
  return cases;
}

function buildSearchSessionListCases(
  sessions: unknown[],
  searchTerms: string[],
): Array<{ match: Record<string, unknown>; response: unknown }> {
  return searchTerms.flatMap((search) => buildSessionListCases(sessions, { search }));
}

function chatHistoryMessage(role: "assistant" | "user", text: string, timestamp: number) {
  return {
    content: [{ text, type: "text" }],
    role,
    timestamp,
  };
}

function buildScrollableChatHistory(baseTime: number): unknown[] {
  const messages: unknown[] = [
    chatHistoryMessage(
      "assistant",
      `Mock Control UI is running with ${TOTAL_MOCK_SESSIONS} sessions. Open the chat picker, search for "telegram" or "claude", then use Load more repeatedly.`,
      baseTime,
    ),
  ];

  for (let index = 1; index <= 36; index += 1) {
    const timestamp = baseTime + index * 60_000;
    messages.push(
      chatHistoryMessage(
        "user",
        `Mock scroll request ${index}: add enough transcript content to exercise the chat scroll container in focused mode.`,
        timestamp,
      ),
      chatHistoryMessage(
        "assistant",
        `Mock scroll response ${index}: this deterministic history keeps the mock chat long enough to scroll while testing focus mode, header collapse, and composer anchoring. `.repeat(
          2,
        ),
        timestamp + 30_000,
      ),
    );
  }

  return messages;
}

function searchPrefixes(term: string): string[] {
  return Array.from({ length: term.length }, (_value, index) => term.slice(0, index + 1));
}

function createChatPickerScenario(): ControlUiMockGatewayScenario {
  const baseTime = Date.parse("2026-05-22T09:00:00.000Z");
  const workspaceFiles = [
    {
      missing: false,
      name: "AGENTS.md",
      path: "/mock/workspace/AGENTS.md",
      size: 2148,
      updatedAtMs: baseTime - 120_000,
    },
    {
      missing: false,
      name: "plan.md",
      path: "/mock/workspace/plan.md",
      size: 912,
      updatedAtMs: baseTime - 90_000,
    },
    {
      missing: false,
      name: "notes/context.md",
      path: "/mock/workspace/notes/context.md",
      size: 1620,
      updatedAtMs: baseTime - 30_000,
    },
  ];
  const workspaceListCases = ["main", "alpha", "openclaw-mock"].map((agentId) => ({
    match: { agentId },
    response: {
      agentId,
      files: workspaceFiles,
      workspace: "/mock/workspace",
    },
  }));
  const workspaceFileContentByName = new Map([
    [
      "AGENTS.md",
      "# AGENTS.md\n\nMock workspace instructions for the composer rail.\n\n- Keep tool output compact.\n- Prefer right-rail context over modal previews.\n",
    ],
    [
      "plan.md",
      "# Composer polish plan\n\n1. Keep the composer controls calm.\n2. Move session selection into the sidebar.\n3. Keep model, reasoning, and speed choices discoverable without taking over the page.\n",
    ],
    [
      "notes/context.md",
      "# Context notes\n\nThe right rail should feel like workspace context, not a modal pasted beside the chat.\n\n## Current focus\n\n- Markdown previews need readable dark-mode chrome.\n- Empty or unavailable content should show a quiet state instead of an empty card.\n- File previews should load from the same mock scenario as the file list.\n",
    ],
  ]);
  const workspaceFileCases = ["main", "alpha", "openclaw-mock"].flatMap((agentId) =>
    workspaceFiles.map((file) => ({
      match: { agentId, name: file.name },
      response: {
        agentId,
        file: {
          ...file,
          content: workspaceFileContentByName.get(file.name) ?? "",
        },
        workspace: "/mock/workspace",
      },
    })),
  );
  const sessionFiles = [
    {
      kind: "modified",
      missing: false,
      name: "chat.ts",
      path: "ui/src/ui/views/chat.ts",
      size: 48320,
      updatedAtMs: baseTime - 20_000,
    },
    {
      kind: "modified",
      missing: false,
      name: "sidebar.css",
      path: "ui/src/styles/chat/sidebar.css",
      size: 18840,
      updatedAtMs: baseTime - 18_000,
    },
    {
      kind: "read",
      missing: false,
      name: "artifacts.ts",
      path: "src/gateway/server-methods/artifacts.ts",
      size: 21876,
      updatedAtMs: baseTime - 300_000,
    },
    {
      kind: "read",
      missing: false,
      name: "sessions.ts",
      path: "packages/gateway-protocol/src/schema/sessions.ts",
      size: 16542,
      updatedAtMs: baseTime - 420_000,
    },
  ];
  const sessionWorkspaceRoot = repoRoot;
  const sessionFileContentByPath = new Map([
    [
      "ui/src/ui/views/chat.ts",
      'function renderSessionWorkspaceRail() {\n  return html`<aside class="chat-workspace-rail">...</aside>`;\n}\n',
    ],
    [
      "ui/src/styles/chat/sidebar.css",
      ".chat-workspace-rail__section-title {\n  color: var(--muted);\n  text-transform: uppercase;\n}\n",
    ],
    [
      "src/gateway/server-methods/artifacts.ts",
      "// Artifact gateway methods collect generated artifacts from session transcripts.\n",
    ],
    [
      "packages/gateway-protocol/src/schema/sessions.ts",
      "export const SessionsFilesListParamsSchema = Type.Object({ sessionKey: NonEmptyString });\n",
    ],
    [
      "package.json",
      '{\n  "name": "openclaw",\n  "scripts": { "dev:ui:mock": "tsx scripts/control-ui-mock-dev.ts" }\n}\n',
    ],
    [
      "ui/vite.config.ts",
      "export default function controlUiViteConfig() {\n  return { server: { strictPort: true } };\n}\n",
    ],
    [
      "ui/src/ui/e2e/chat-flow.e2e.test.ts",
      "it('keeps the session workspace useful while browsing files', async () => {\n  await page.getByText('Project files').waitFor();\n});\n",
    ],
  ]);
  const sessionFileCases = [
    {
      match: { sessionKey: "agent:alpha" },
      response: {
        browser: {
          entries: [
            {
              kind: "directory",
              name: "packages",
              path: "packages",
              sessionKind: "read",
              updatedAtMs: baseTime - 420_000,
            },
            {
              kind: "directory",
              name: "src",
              path: "src",
              sessionKind: "read",
              updatedAtMs: baseTime - 300_000,
            },
            {
              kind: "directory",
              name: "ui",
              path: "ui",
              sessionKind: "modified",
              updatedAtMs: baseTime - 20_000,
            },
            {
              kind: "file",
              name: "package.json",
              path: "package.json",
              size: 92750,
              updatedAtMs: baseTime - 800_000,
            },
          ],
          path: "",
        },
        files: sessionFiles,
        root: sessionWorkspaceRoot,
        sessionKey: "agent:alpha",
      },
    },
  ];
  const sessionFileGetCases = sessionFiles.map((file) => ({
    match: { sessionKey: "agent:alpha", path: file.path },
    response: {
      file: {
        ...file,
        content: sessionFileContentByPath.get(file.path) ?? "",
      },
      root: sessionWorkspaceRoot,
      sessionKey: "agent:alpha",
    },
  }));
  const lobsterSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#10151d"/>
  <circle cx="320" cy="185" r="76" fill="#e23f3f"/>
  <ellipse cx="250" cy="178" rx="54" ry="38" fill="#f05a52"/>
  <ellipse cx="390" cy="178" rx="54" ry="38" fill="#f05a52"/>
  <circle cx="292" cy="145" r="10" fill="#0b0f14"/>
  <circle cx="348" cy="145" r="10" fill="#0b0f14"/>
  <path d="M232 114c-72-44-135-22-146 35 52 9 91-4 125-39" fill="none" stroke="#f06b5f" stroke-width="28" stroke-linecap="round"/>
  <path d="M408 114c72-44 135-22 146 35-52 9-91-4-125-39" fill="none" stroke="#f06b5f" stroke-width="28" stroke-linecap="round"/>
  <path d="M232 246c-45 28-91 35-142 23M408 246c45 28 91 35 142 23" fill="none" stroke="#e14b47" stroke-width="16" stroke-linecap="round"/>
  <text x="320" y="326" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-size="24" fill="#f6f7f9">openclaw session artifact</text>
</svg>`;
  const lobsterArtifact = {
    id: "artifact-openclaw-lobster",
    type: "image",
    title: "openclaw-lobster-preview.svg",
    mimeType: "image/svg+xml",
    sizeBytes: Buffer.byteLength(lobsterSvg, "utf8"),
    source: "session-transcript",
    download: { mode: "bytes" },
  };
  const sessions = [
    sessionRow("agent:alpha", "Alpha planning", baseTime - 1_000),
    ...buildSessionRows({
      baseTime: baseTime - 60_000,
      count: TOTAL_MOCK_SESSIONS - 1,
      keyPrefix: "history",
      labelPrefix: "Long running session",
    }),
  ];
  const telegramSessions = buildSessionRows({
    baseTime: baseTime - 30_000,
    count: TOTAL_TELEGRAM_SESSIONS,
    keyPrefix: "telegram",
    labelPrefix: "Telegram investigation",
  });
  const claudeSessions = buildSessionRows({
    baseTime: baseTime - 45_000,
    count: 75,
    keyPrefix: "model-claude",
    labelPrefix: "Model search result",
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
  });
  return {
    assistantAgentId: "openclaw-mock",
    assistantName: "OpenClaw mock",
    defaultAgentId: "openclaw-mock",
    historyMessages: buildScrollableChatHistory(baseTime),
    methodResponses: {
      "agents.files.get": {
        cases: workspaceFileCases,
      },
      "agents.files.list": {
        cases: workspaceListCases,
      },
      "sessions.files.get": {
        cases: sessionFileGetCases,
      },
      "sessions.files.list": {
        cases: [
          {
            match: { sessionKey: "agent:alpha", path: "ui" },
            response: {
              browser: {
                entries: [
                  {
                    kind: "directory",
                    name: "src",
                    path: "ui/src",
                    sessionKind: "modified",
                    updatedAtMs: baseTime - 20_000,
                  },
                  {
                    kind: "file",
                    name: "vite.config.ts",
                    path: "ui/vite.config.ts",
                    size: 9860,
                    updatedAtMs: baseTime - 900_000,
                  },
                ],
                parentPath: "",
                path: "ui",
              },
              files: sessionFiles,
              root: sessionWorkspaceRoot,
              sessionKey: "agent:alpha",
            },
          },
          {
            match: { sessionKey: "agent:alpha", search: "chat" },
            response: {
              browser: {
                entries: [
                  {
                    kind: "file",
                    name: "chat.ts",
                    path: "ui/src/ui/views/chat.ts",
                    sessionKind: "modified",
                    size: 48320,
                    updatedAtMs: baseTime - 20_000,
                  },
                  {
                    kind: "file",
                    name: "chat-flow.e2e.test.ts",
                    path: "ui/src/ui/e2e/chat-flow.e2e.test.ts",
                    size: 24950,
                    updatedAtMs: baseTime - 25_000,
                  },
                ],
                path: "",
                search: "chat",
              },
              files: sessionFiles,
              root: sessionWorkspaceRoot,
              sessionKey: "agent:alpha",
            },
          },
          ...sessionFileCases,
        ],
      },
      "artifacts.list": {
        cases: [
          {
            match: { sessionKey: "agent:alpha" },
            response: { artifacts: [lobsterArtifact] },
          },
        ],
      },
      "artifacts.download": {
        cases: [
          {
            match: { sessionKey: "agent:alpha", artifactId: lobsterArtifact.id },
            response: {
              artifact: lobsterArtifact,
              data: Buffer.from(lobsterSvg, "utf8").toString("base64"),
              encoding: "base64",
            },
          },
        ],
      },
      "sessions.list": {
        cases: [
          ...buildSearchSessionListCases(telegramSessions, searchPrefixes("telegram")),
          ...buildSearchSessionListCases(claudeSessions, [
            ...searchPrefixes("claude"),
            ...searchPrefixes("claude-sonnet-4-6"),
            ...searchPrefixes("anthropic"),
          ]),
          ...buildSessionListCases(sessions),
        ],
      },
    },
    models: [
      { id: "gpt-5.5", name: "gpt-5.5", provider: "openai" },
      { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", provider: "anthropic" },
    ],
    sessionKey: "agent:alpha",
  };
}

function escapeScriptContent(script: string): string {
  return script.replaceAll("</script", "<\\/script");
}

// A signed-in student, with enough of a lab around her that the member surfaces have something to
// show. The mock gateway speaks the chat/session RPCs but none of the AdminBot ones, so the roster,
// papers and onboarding checklist have no source -- this seeds them directly onto the app element,
// which is the same thing a real member session would end up doing.
//
// Dev-only, and deliberately a fixed cast rather than randomised output: a demo you can point at
// twice and see the same thing is worth more than novelty.
const MOCK_STUDENT = {
  member: {
    id: "mock-student-1",
    name: "Ada Okafor",
    email: "ada@jinesis.lab",
    role: "PhD Student",
    status: "active",
    privilege_level: "member",
    affiliation: "University of Toronto",
    research_topics: ["multi-agent negotiation", "evaluation", "causal inference"],
    projects: ["Negotiation Arena", "Eval Harness", "Causal Probes"],
    hours_per_week: 40,
    // location / timezone / slack_user_id / personal_website left blank on purpose: they are what
    // the profile page's "fill in the blanks" form exists to collect.
  },
  lab: [
    { id: "prof-zhijing", name: "Zhijing Jin", role: "Professor", privilege_level: "admin" },
    { id: "m-noor", name: "Noor Haddad", role: "Postdoc", privilege_level: "core_member" },
    { id: "m-kenji", name: "Kenji Watanabe", role: "Master's Student", privilege_level: "member" },
    { id: "m-lucia", name: "Lucia Ferreira", role: "Research Assistant", privilege_level: "member" },
  ],
  papers: [
    {
      id: "paper-negotiation-arena",
      title: "Negotiation Arena: bargaining benchmarks for LLM agents",
      authors: ["Ada Okafor", "Noor Haddad", "Zhijing Jin"],
      current_step: "overleaf_writing",
      mentor_member_id: "prof-zhijing",
      submitted_by_member_id: "mock-student-1",
      created_at: "2026-04-02T09:00:00Z",
      updated_at: "2026-07-28T16:12:00Z",
    },
    {
      id: "paper-eval-gaps",
      title: "What evaluation misses in multi-agent settings",
      authors: ["Ada Okafor", "Kenji Watanabe"],
      current_step: "submission",
      mentor_member_id: "m-noor",
      created_at: "2026-02-18T09:00:00Z",
      updated_at: "2026-08-01T11:30:00Z",
    },
    {
      id: "paper-causal-probes",
      title: "Causal probes for instruction-tuned models",
      authors: ["Lucia Ferreira", "Ada Okafor"],
      current_step: "social_posts",
      mentor_member_id: "prof-zhijing",
      created_at: "2025-11-05T09:00:00Z",
      updated_at: "2026-06-20T14:45:00Z",
    },
    // Not hers -- present so "my papers" is visibly a filter rather than the whole table.
    {
      id: "paper-not-mine",
      title: "Scaling laws for retrieval-augmented agents",
      authors: ["Kenji Watanabe", "Noor Haddad"],
      current_step: "arxiv_polish",
      created_at: "2026-03-11T09:00:00Z",
      updated_at: "2026-07-02T10:00:00Z",
    },
  ],
  onboardingSteps: [
    ["slack", "Join the lab Slack", "Getting started", "complete"],
    ["calendar_invite", "Accept the lab calendar invite", "Getting started", "complete"],
    ["guidebook", "Skim the lab guidebook", "Getting started", "complete"],
    ["compute", "Request GPU access on Aurora", "Compute access", "current"],
    ["twitter", "Follow the lab account", "Social media", "remaining"],
    ["intro_meeting", "Book your intro meeting with Zhijing", "Working with us", "remaining"],
    ["reading_group", "Sign up for a reading group slot", "Working with us", "remaining"],
  ],
} as const;

// Saving needs more than seeded state. Every AdminBot write goes over HTTP to the service with a
// stored member session, and the mock has neither -- so `loadStoredMemberSession()` returned null,
// profile saves short-circuited with "Sign in with your member account", and paper saves fell
// through to a gateway tool the mock does not implement. Nothing could persist.
//
// So the seed installs a fake service: a member session in localStorage, plus a `fetch` shim over
// the four routes the Control UI actually uses. Writes land in an in-memory store that the reads
// serve back, which is exactly the contract the real service offers -- so the app's own load,
// save, and reload path runs unmodified, and edits stick for the life of the tab.
function createMockStudentSeedScript(): string {
  return `
(() => {
  const DATA = ${JSON.stringify(MOCK_STUDENT)};
  const steps = DATA.onboardingSteps.map(([id, label, category, status]) => ({
    id, label, category, status, required: true,
  }));
  const remaining = steps.filter((step) => step.status !== "complete");
  const onboarding = {
    steps,
    completed: steps.filter((step) => step.status === "complete"),
    remaining,
    current_step: remaining[0],
  };

  // The store the fake service reads and writes. Seeded once; every later mutation goes here.
  const store = {
    members: [{ ...DATA.member, onboarding }, ...DATA.lab],
    papers: DATA.papers.map((paper) => ({ ...paper })),
    settings: {
      paper_escalation_business_days: 3,
      head_professor_member_id: "prof-zhijing",
      updated_at: "2026-07-01T00:00:00Z",
    },
  };

  localStorage.setItem(
    "openclaw.adminbot.session.v1",
    JSON.stringify({ sessionToken: "mock-session-token", expiresAt: 4102444800000 }),
  );

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    let path;
    try {
      path = new URL(url, location.href).pathname;
    } catch {
      return realFetch(input, init);
    }
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (path.endsWith("/lab/members") && method === "GET") return json({ members: store.members });
    if (path.endsWith("/papers") && method === "GET") return json({ papers: store.papers });
    if (path.endsWith("/settings") && method === "GET") return json(store.settings);

    // Split rather than match: this string is emitted into a <script> from a template literal,
    // where a regex literal's escapes are one more layer to get wrong.
    const segments = path.split("/").filter(Boolean);
    const last = decodeURIComponent(segments[segments.length - 1] ?? "");
    const parent = segments.slice(0, -1).join("/");

    if (method === "PUT" && parent.endsWith("lab/members")) {
      const index = store.members.findIndex((member) => member.id === last);
      if (index < 0) return json({ error: "not_found" }, 404);
      // Merge, dropping keys the caller left blank so a partial edit cannot wipe a field.
      const patch = Object.fromEntries(
        Object.entries(body ?? {}).filter(([, value]) =>
          Array.isArray(value) ? value.length : value !== "" && value !== undefined && value !== null,
        ),
      );
      store.members[index] = { ...store.members[index], ...patch };
      return json(store.members[index]);
    }

    if (method === "PUT" && parent.endsWith("papers")) {
      const now = new Date(4102444800000).toISOString();
      const index = store.papers.findIndex((paper) => paper.id === last);
      if (index < 0) {
        // A member filing something new: the real service creates it and stamps the author.
        store.papers = [
          ...store.papers,
          { id: last, submitted_by_member_id: DATA.member.id, created_at: now, updated_at: now, ...body },
        ];
        return json(store.papers[store.papers.length - 1]);
      }
      store.papers[index] = { ...store.papers[index], ...body, updated_at: now };
      return json(store.papers[index]);
    }

    return realFetch(input, init);
  };

  customElements.whenDefined("openclaw-app").then(() => {
    const app = document.querySelector("openclaw-app");
    if (!app) return;
    app.memberId = DATA.member.id;
    app.memberPrivilegeLevel = DATA.member.privilege_level;
    app.adminBotOnboarding = onboarding;
    app.registrations = [];
    // The app's own AdminBot load already ran and bailed -- it fired before this script had a
    // session to load with. Paint the first frame from the store directly; every load after this
    // (including the reload each save triggers) goes through the fetch shim above and reads the
    // same store, so what is on screen and what is "on the server" stay the same object.
    const paint = () => {
      app.adminBotData = {
        ...app.adminBotData,
        members: store.members,
        papers: store.papers,
        settings: store.settings,
        proposals: [],
        loadedAt: 4102444800000,
      };
      app.adminBotError = null;
      app.adminBotLoading = false;
      // Holding a member session sends the app down the "connect as this member" path, which asks
      // the service for a gateway token -- a route this shim does not serve, so the connection
      // fails and the whole shell drops to the login gate. The mock gateway is already up; just
      // keep the flag it sets, rather than teaching the shim to mint tokens.
      app.connected = true;
    };
    paint();
    let ticks = 0;
    const timer = setInterval(() => {
      if (!app.adminBotData?.members?.length || !app.connected) paint();
      if ((ticks += 1) > 40) clearInterval(timer);
    }, 250);
  });
})();
`;
}

function createMockGatewayPlugin(scenario: ControlUiMockGatewayScenario): Plugin {
  const initScript = escapeScriptContent(createControlUiMockGatewayInitScript(scenario));
  const bootstrapBody = JSON.stringify(createControlUiMockBootstrapConfig(scenario));
  return {
    configureServer(server) {
      server.middlewares.use(CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(bootstrapBody);
      });
    },
    name: "openclaw-control-ui-mock-gateway",
    transformIndexHtml(html) {
      const studentScript = escapeScriptContent(createMockStudentSeedScript());
      return html.replace(
        "</head>",
        `    <script data-openclaw-control-ui-mock-gateway>\n${initScript}\n    </script>\n` +
          `    <script data-openclaw-control-ui-mock-student>\n${studentScript}\n    </script>\n  </head>`,
      );
    },
  };
}

function hostForUrl(boundAddress: string, requestedHost: string): string {
  const host = boundAddress === "0.0.0.0" || boundAddress === "::" ? requestedHost : boundAddress;
  const reachableHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return reachableHost.includes(":") ? `[${reachableHost}]` : reachableHost;
}

function resolveServerUrl(server: ViteDevServer, requestedHost: string): string {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Control UI mock server did not expose a TCP port");
  }
  // The root, not /chat: it resolves to the dashboard, which is where a signed-in member lands.
  return `http://${hostForUrl(address.address, requestedHost)}:${address.port}/`;
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const options = parseArgs(process.argv.slice(2));
const scenario = createChatPickerScenario();
const server = await createServer({
  base: "/",
  cacheDir: path.join(repoRoot, ".artifacts", "control-ui-mock-vite"),
  clearScreen: false,
  configFile: path.join(uiRoot, "vite.config.ts"),
  define: {
    OPENCLAW_CONTROL_UI_BUILD_ID: JSON.stringify("mock"),
  },
  logLevel: "error",
  optimizeDeps: {
    include: ["lit/directives/repeat.js"],
  },
  plugins: [createMockGatewayPlugin(scenario)],
  publicDir: path.join(uiRoot, "public"),
  resolve: {
    alias: [...resolveSourcePackageAliasesForVite(), ...resolveTsconfigPathAliasesForVite()],
  },
  root: uiRoot,
  server: {
    allowedHosts: options.allowedHosts,
    host: options.host,
    port: options.port,
    strictPort: true,
  },
});

await server.listen();
console.log(`[control-ui-mock] ${resolveServerUrl(server, options.host)}`);
await waitForShutdown();
await server.close();
