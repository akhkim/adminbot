import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  AdminBotActionProposal,
  AdminBotApprovalRequest,
  AdminBotExecutionRequest,
  AdminBotLabMemberInput,
  AdminBotPaperRecordInput,
  AdminBotPrivacyTaskRequest,
  AdminBotRemovePendingRequest,
  AdminBotSettingsInput,
} from "./contracts.js";
import { createAdminBotPrivacyBroker, type AdminBotPrivacyBroker } from "./privacy-broker.js";
import type {
  AdminBotReimbursementRequest,
  AdminBotReimbursementWorkflow,
} from "./reimbursement-workflow.js";
import {
  createAdminBotSensitiveInfoDocument,
  type AdminBotSensitiveInfoDocument,
} from "./sensitive-info-doc.js";
import {
  AdminBotService,
  type AdminBotActionExecutor,
  type AdminBotServiceOptions,
  type AdminBotServiceResponse,
} from "./service-core.js";
import { createAdminBotSqliteService } from "./service-sqlite.js";
import { renderAdminBotWebUi } from "./web-ui.js";
import { renderDeadlinesWebUi } from "./deadlines-web-ui.js";
import { DEADLINE_VENUES } from "./deadlines-dataset.js";

export type AdminBotMockServiceOptions = {
  databasePath?: string;
  auditRetentionDays?: number;
  executor?: AdminBotActionExecutor;
  privacyBroker?: AdminBotPrivacyBroker;
  sensitiveInfoPath?: string;
  sensitiveInfoDocument?: AdminBotSensitiveInfoDocument;
  emailAutomationRunner?: () => Promise<unknown>;
  reimbursementWorkflow?: AdminBotReimbursementWorkflow;
};

export function createAdminBotMockService(options: AdminBotMockServiceOptions = {}) {
  const durable = options.databasePath
    ? createAdminBotSqliteService({
        databasePath: options.databasePath,
        ...serviceOptions(options),
      })
    : undefined;
  const service = durable?.service ?? new AdminBotService(undefined, serviceOptions(options));
  const sensitiveInfo =
    options.sensitiveInfoDocument ??
    createAdminBotSensitiveInfoDocument({
      filePath: options.sensitiveInfoPath,
    });
  const privacyBroker =
    options.privacyBroker ??
    createAdminBotPrivacyBroker(undefined, {
      sensitiveTermsProvider: () => sensitiveInfo.listSensitiveTerms(),
    });
  let activeEmailAutomation: Promise<unknown> | undefined;
  const emailAutomationRunner = options.emailAutomationRunner;
  const runEmailAutomation = emailAutomationRunner
    ? () => {
        activeEmailAutomation ??= emailAutomationRunner().finally(() => {
          activeEmailAutomation = undefined;
        });
        return activeEmailAutomation;
      }
    : undefined;
  const server = createServer(async (req, res) => {
    try {
      await routeRequest(
        req,
        res,
        service,
        privacyBroker,
        sensitiveInfo,
        runEmailAutomation,
        options.reimbursementWorkflow,
      );
    } catch (error) {
      sendJson(res, 500, {
        error: { message: error instanceof Error ? error.message : "mock service failed" },
      });
    }
  });
  return {
    server,
    service,
    async listen(port = 8765, host = "127.0.0.1") {
      await listen(server, port, host);
      return `http://${host}:${port}`;
    },
    close() {
      durable?.close();
    },
  };
}

function serviceOptions(options: AdminBotMockServiceOptions): AdminBotServiceOptions {
  return {
    ...(typeof options.auditRetentionDays === "number"
      ? { auditRetentionDays: options.auditRetentionDays }
      : {}),
    ...(options.executor ? { executor: options.executor } : {}),
  };
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: AdminBotService,
  privacyBroker: AdminBotPrivacyBroker,
  sensitiveInfo: AdminBotSensitiveInfoDocument,
  runEmailAutomation?: () => Promise<unknown>,
  reimbursementWorkflow?: AdminBotReimbursementWorkflow,
) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/adminbot")) {
    sendHtml(res, 200, renderAdminBotWebUi());
    return;
  }
  if (req.method === "GET" && url.pathname === "/deadlines") {
    sendHtml(res, 200, renderDeadlinesWebUi(DEADLINE_VENUES));
    return;
  }
  if (req.method === "GET" && url.pathname === "/deadlines/venues.json") {
    sendJson(res, 200, { items: DEADLINE_VENUES });
    return;
  }
  if (req.method === "POST" && url.pathname === "/automation/email/run") {
    if (!runEmailAutomation) {
      sendJson(res, 503, { error: { message: "email automation runner is not configured" } });
      return;
    }
    sendJson(res, 200, await runEmailAutomation());
    return;
  }
  if (req.method === "POST" && url.pathname === "/reimbursements/converse") {
    if (!reimbursementWorkflow) {
      sendJson(res, 503, { error: { message: "reimbursement workflow is not configured" } });
      return;
    }
    const body = (await readJson(req)) as AdminBotReimbursementRequest;
    sendJson(res, 200, await reimbursementWorkflow.converse(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/reimbursements/generate") {
    if (!reimbursementWorkflow) {
      sendJson(res, 503, { error: { message: "reimbursement workflow is not configured" } });
      return;
    }
    const body = (await readJson(req)) as AdminBotReimbursementRequest;
    sendJson(res, 200, await reimbursementWorkflow.generate(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/proposals") {
    const body = (await readJson(req)) as AdminBotActionProposal;
    sendServiceResult(res, service.createProposal(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/privacy/tasks") {
    const body = (await readJson(req)) as AdminBotPrivacyTaskRequest;
    sendJson(res, 200, await privacyBroker.handle(body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/proposals/pending") {
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    sendServiceResult(res, service.listPending(limit));
    return;
  }
  if (req.method === "GET" && url.pathname === "/lab/members") {
    sendServiceResult(res, service.listLabMembers());
    return;
  }
  if (req.method === "GET" && url.pathname === "/settings") {
    sendServiceResult(res, service.getSettings());
    return;
  }
  if (req.method === "PUT" && url.pathname === "/settings") {
    const body = (await readJson(req)) as AdminBotSettingsInput;
    sendServiceResult(res, service.updateSettings(body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/sensitive-info") {
    sendJson(res, 200, await sensitiveInfo.get());
    return;
  }
  if (req.method === "PUT" && url.pathname === "/sensitive-info") {
    const body = readRecord(await readJson(req));
    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    sendJson(res, 200, await sensitiveInfo.update(markdown));
    return;
  }
  const labMember = /^\/lab\/members\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "PUT" && labMember?.[1]) {
    const memberId = decodeURIComponent(labMember[1]);
    const body = (await readJson(req)) as AdminBotLabMemberInput;
    sendServiceResult(res, service.upsertLabMember({ ...body, id: memberId }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers") {
    sendServiceResult(res, service.listPapers());
    return;
  }
  const paper = /^\/papers\/([^/]+)$/u.exec(url.pathname);
  if (req.method === "PUT" && paper?.[1]) {
    const paperId = decodeURIComponent(paper[1]);
    const body = (await readJson(req)) as AdminBotPaperRecordInput;
    sendServiceResult(res, service.upsertPaper({ ...body, id: paperId }));
    return;
  }
  if (req.method === "DELETE" && paper?.[1]) {
    sendServiceResult(res, service.deletePaper(decodeURIComponent(paper[1])));
    return;
  }
  if (req.method === "GET" && url.pathname === "/papers/nudges") {
    sendServiceResult(res, service.listPaperNudges(url.searchParams.get("now") ?? undefined));
    return;
  }
  const remove = /^\/proposals\/([^/]+)\/remove$/u.exec(url.pathname);
  if (req.method === "POST" && remove?.[1]) {
    const actionId = decodeURIComponent(remove[1]);
    const body = (await readJson(req)) as AdminBotRemovePendingRequest;
    sendServiceResult(res, service.removePending(actionId, body));
    return;
  }
  const approve = /^\/approvals\/([^/]+)\/approve$/u.exec(url.pathname);
  if (req.method === "POST" && approve?.[1]) {
    const actionId = decodeURIComponent(approve[1]);
    const body = (await readJson(req)) as AdminBotApprovalRequest;
    sendServiceResult(res, service.approve(actionId, body));
    return;
  }
  const execute = /^\/actions\/([^/]+)\/execute$/u.exec(url.pathname);
  if (req.method === "POST" && execute?.[1]) {
    const actionId = decodeURIComponent(execute[1]);
    const body = (await readJson(req)) as AdminBotExecutionRequest;
    sendServiceResult(res, await service.execute(actionId, body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/audit") {
    sendJson(res, 200, { events: service.listAuditEvents() });
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function sendServiceResult<T>(res: ServerResponse, result: AdminBotServiceResponse<T>): void {
  if (result.ok) {
    sendJson(res, result.status, result.payload);
    return;
  }
  sendJson(res, result.status, { error: result.error });
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
