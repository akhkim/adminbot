import { pathToFileURL } from "node:url";
import { AvailabilityWorkspaceService } from "@adminbot/availability";
import {
  RegistrationReviewService,
  RegistrationService,
  SessionService,
} from "@adminbot/identity";
import { openPersistence } from "@adminbot/persistence";
import { PaperWorkspaceService } from "@adminbot/papers";
import {
  bundledReimbursementHelperPath,
  LocalReimbursementRuntime,
  ReimbursementService,
} from "@adminbot/reimbursements";
import { AdminBotApiServer } from "./server.js";

export async function startFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  const organizationId = requiredEnvironment(environment, "ADMINBOT_ORGANIZATION_ID");
  const keySecret = requiredEnvironment(environment, "ADMINBOT_IDENTITY_KEY_SECRET");
  const databaseUrl =
    environment.ADMINBOT_DATABASE_URL?.trim() || "file:./state/adminbot-v2.sqlite";
  const port = parsePort(environment.ADMINBOT_API_PORT);
  const allowedOrigins = splitOrigins(environment.ADMINBOT_WEB_ORIGINS);
  const persistence = openPersistence({ databaseUrl });
  const registration = new RegistrationService({
    transactions: persistence.transactions,
    organizationId,
    keySecret,
  });
  const sessions = new SessionService({
    transactions: persistence.transactions,
    organizationId,
    keySecret,
  });
  const registrationReview = new RegistrationReviewService({
    transactions: persistence.transactions,
    organizationId,
  });
  const papers = new PaperWorkspaceService({
    transactions: persistence.transactions,
    organizationId,
  });
  const availability = new AvailabilityWorkspaceService({
    transactions: persistence.transactions,
    organizationId,
  });
  const reimbursements = new ReimbursementService({
    transactions: persistence.transactions,
    keySecret,
    runtime: new LocalReimbursementRuntime({
      helperScriptPath: bundledReimbursementHelperPath(),
      pythonCommand: environment.ADMINBOT_REIMBURSEMENT_PYTHON?.trim() || "python3",
      environment,
    }),
    onDependencyError: (operation, error) => {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(JSON.stringify({ event: "reimbursement.dependency_failed", operation, errorType }));
    },
  });
  const api = new AdminBotApiServer({
    registration,
    registrationReview,
    sessions,
    papers,
    availability,
    reimbursements,
    allowedOrigins,
    secureCookies: parseBoolean(environment.ADMINBOT_SECURE_COOKIES, false),
    onUnexpectedError: (error) => {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(JSON.stringify({ event: "api.request_failed", errorType }));
    },
  });

  try {
    const listening = await api.listen({ port });
    console.log(JSON.stringify({ event: "api.listening", origin: listening.origin }));
    return async () => {
      await listening.close();
      await persistence.close();
    };
  } catch (error) {
    await persistence.close();
    throw error;
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 8_765;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("ADMINBOT_API_PORT must be an integer between 1 and 65535");
  }
  return value;
}

function splitOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("ADMINBOT_SECURE_COOKIES must be true or false");
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  void startFromEnvironment().then((stop) => {
    const shutdown = () => {
      void stop().then(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
