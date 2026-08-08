import {
  apiRoutes,
  createApiUrl,
  type ErrorResponse,
  type GenerateReimbursementPacketInput,
  type ReimbursementConversationInput,
  type ReimbursementConversationResult,
  type ReimbursementPacketResult,
} from "@adminbot/api-contracts";

export class ReimbursementApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ReimbursementApiError";
  }
}

export interface ReimbursementClient {
  converse(input: ReimbursementConversationInput): Promise<ReimbursementConversationResult>;
  generate(input: GenerateReimbursementPacketInput): Promise<ReimbursementPacketResult>;
}

export class ReimbursementApiClient implements ReimbursementClient {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly serviceOrigin: string, fetch?: typeof globalThis.fetch) {
    this.fetch = fetch ?? globalThis.fetch.bind(globalThis);
  }

  converse(input: ReimbursementConversationInput): Promise<ReimbursementConversationResult> {
    return this.json(apiRoutes.converseReimbursement.build(), input) as Promise<ReimbursementConversationResult>;
  }

  generate(input: GenerateReimbursementPacketInput): Promise<ReimbursementPacketResult> {
    return this.json(apiRoutes.generateReimbursementPacket.build(), input) as Promise<ReimbursementPacketResult>;
  }

  private async json(path: string, input: unknown): Promise<unknown> {
    const response = await this.fetch(createApiUrl(this.serviceOrigin, path), {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as ErrorResponse | undefined;
      throw new ReimbursementApiError(
        response.status,
        body?.code ?? "internal_error",
        body?.message ?? "Reimbursement request failed",
      );
    }
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
      throw new ReimbursementApiError(502, "dependency_unavailable", "AdminBot returned an invalid response");
    }
    return response.json();
  }
}

export async function encodeReceipt(file: File): Promise<{
  filename: string;
  mediaType: "application/pdf" | "image/png" | "image/jpeg";
  dataBase64: string;
}> {
  if (!isReceiptMediaType(file.type)) throw new Error(`${file.name} must be a PDF, PNG, or JPEG.`);
  if (file.size > 12 * 1_024 * 1_024) throw new Error(`${file.name} exceeds 12 MB.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return { filename: file.name, mediaType: file.type, dataBase64: btoa(binary) };
}

function isReceiptMediaType(value: string): value is "application/pdf" | "image/png" | "image/jpeg" {
  return value === "application/pdf" || value === "image/png" || value === "image/jpeg";
}
