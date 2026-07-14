// Gateway RPC handlers for one-shot operator secret input requests.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateOperatorSecretRequestParams,
  validateOperatorSecretResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  OperatorSecretManager,
  type OperatorSecretRequestPayload,
} from "../operator-secret-manager.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_OPERATOR_SECRET_TIMEOUT_MS = 120_000;
const MAX_OPERATOR_SECRET_TIMEOUT_MS = 600_000;

function resolveTimeoutMs(value: unknown): number {
  return Math.min(
    MAX_OPERATOR_SECRET_TIMEOUT_MS,
    Math.max(
      1,
      Math.floor(
        typeof value === "number" && Number.isFinite(value)
          ? value
          : DEFAULT_OPERATOR_SECRET_TIMEOUT_MS,
      ),
    ),
  );
}

/** Create operator secret input handlers backed by the shared secret manager. */
export function createOperatorSecretHandlers(
  manager: OperatorSecretManager,
): GatewayRequestHandlers {
  return {
    "operator.secret.list": async ({ respond }) => {
      respond(true, manager.listPendingRecords(), undefined);
    },
    "operator.secret.request": async ({ params, respond, context }) => {
      if (!validateOperatorSecretRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid operator.secret.request params: ${formatValidationErrors(
              validateOperatorSecretRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as OperatorSecretRequestPayload & { timeoutMs?: number };
      const request: OperatorSecretRequestPayload = {
        title: p.title,
        description: p.description,
        variableName: p.variableName,
        agentId: p.agentId ?? null,
        sessionKey: p.sessionKey ?? null,
      };
      const timeoutMs = resolveTimeoutMs(p.timeoutMs);
      const record = manager.create(request, timeoutMs);
      const valuePromise = manager.register(record, timeoutMs);
      context.broadcast("operator.secret.requested", record, { dropIfSlow: true });
      const value = await valuePromise;
      respond(
        true,
        {
          id: record.id,
          value,
          cancelled: value === null,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        undefined,
      );
    },
    "operator.secret.resolve": async ({ params, respond, context }) => {
      if (!validateOperatorSecretResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid operator.secret.resolve params: ${formatValidationErrors(
              validateOperatorSecretResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; value?: string; cancelled?: boolean };
      const value = p.cancelled === true ? null : (p.value ?? "");
      if (value !== null && value.length === 0) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "secret value required"));
        return;
      }
      const resolved = manager.resolve(p.id, value);
      if (!resolved) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.APPROVAL_NOT_FOUND, "secret request not found"),
        );
        return;
      }
      const event = { id: p.id, cancelled: value === null, ts: Date.now() };
      context.broadcast("operator.secret.resolved", event, { dropIfSlow: true });
      respond(true, event, undefined);
    },
  };
}
