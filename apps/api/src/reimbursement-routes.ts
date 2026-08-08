import { apiRoutes } from "@adminbot/api-contracts";
import type { ReimbursementResult } from "@adminbot/reimbursements";
import type { ApiResponse, ApiRouteHandler } from "./route-handler.js";

const MAXIMUM_CONVERSATION_BODY_BYTES = 49 * 1_024 * 1_024;
const MAXIMUM_PACKET_BODY_BYTES = 512 * 1_024;

export interface ReimbursementApplication {
  converse(input: unknown, context: { readonly remoteAddress?: string }): Promise<ReimbursementResult>;
  generate(input: unknown, context: { readonly remoteAddress?: string }): Promise<ReimbursementResult>;
}

export function createReimbursementRoutes(
  reimbursements: ReimbursementApplication,
): readonly ApiRouteHandler[] {
  return Object.freeze([
    {
      route: apiRoutes.converseReimbursement,
      body: "json",
      maximumBodyBytes: MAXIMUM_CONVERSATION_BODY_BYTES,
      handle: async (context) => toApiResponse(await reimbursements.converse(
        context.body,
        remoteContext(context.remoteAddress),
      )),
    },
    {
      route: apiRoutes.generateReimbursementPacket,
      body: "json",
      maximumBodyBytes: MAXIMUM_PACKET_BODY_BYTES,
      handle: async (context) => toApiResponse(await reimbursements.generate(
        context.body,
        remoteContext(context.remoteAddress),
      )),
    },
  ] satisfies readonly ApiRouteHandler[]);
}

function remoteContext(remoteAddress: string | undefined): { readonly remoteAddress?: string } {
  return remoteAddress === undefined ? {} : { remoteAddress };
}

function toApiResponse(result: ReimbursementResult): ApiResponse {
  return result.ok || result.retryAfterSeconds === undefined
    ? result
    : { ...result, headers: { "retry-after": String(result.retryAfterSeconds) } };
}
