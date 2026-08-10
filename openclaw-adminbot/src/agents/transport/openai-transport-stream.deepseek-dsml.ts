/**
 * OpenAI-completions stream: DeepSeek DSML tool-call recovery.
 *
 * Some DeepSeek deployments emit tool calls as inline DSML markup in the text
 * channel instead of as structured tool_calls. This recovers them from the text
 * stream incrementally, which is why the scanner tracks the longest open-token
 * prefix that could still be completed by the next chunk — a naive per-chunk
 * match would split a token across a boundary and leak markup into the reply.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getCompat } from "./openai-transport-stream.compat.js";

export function shouldFilterDeepSeekDsmlText(compat: ReturnType<typeof getCompat>) {
  return compat.thinkingFormat === "deepseek";
}

export type RecoveredDeepSeekDsmlToolCall = {
  kind: "toolCall";
  name: string;
  arguments: Record<string, unknown>;
  partialArgs: string;
};

export type DeepSeekDsmlRecoveredPart =
  | { kind: "text"; text: string }
  | RecoveredDeepSeekDsmlToolCall;

export const DEEPSEEK_DSML_BARS = ["|", "｜"] as const;
export const DEEPSEEK_DSML_TOOL_KINDS = ["tool_calls", "tool_call", "function_calls"] as const;
export const DEEPSEEK_DSML_TOOL_OPEN_TOKENS = DEEPSEEK_DSML_BARS.flatMap((bar) =>
  DEEPSEEK_DSML_TOOL_KINDS.map((kind) => `<${bar}DSML${bar}${kind}>`),
);
export const DEEPSEEK_DSML_TOOL_CLOSE_TOKENS = DEEPSEEK_DSML_BARS.flatMap((bar) =>
  DEEPSEEK_DSML_TOOL_KINDS.map((kind) => `</${bar}DSML${bar}${kind}>`),
);
export const DEEPSEEK_DSML_TOOL_MAX_OPEN_TOKEN_LEN = Math.max(
  ...DEEPSEEK_DSML_TOOL_OPEN_TOKENS.map((token) => token.length),
);

export function createDeepSeekDsmlToolCallRecoverer() {
  let buffer = "";

  const consume = (final: boolean): DeepSeekDsmlRecoveredPart[] => {
    const output: DeepSeekDsmlRecoveredPart[] = [];
    while (buffer) {
      const open = findEarliestStringToken(buffer, DEEPSEEK_DSML_TOOL_OPEN_TOKENS);
      if (!open) {
        if (final) {
          output.push({ kind: "text", text: buffer });
          buffer = "";
          return output;
        }
        const keep = longestDeepSeekDsmlToolOpenPrefixSuffixLength(buffer);
        const emitLength = buffer.length - keep;
        if (emitLength > 0) {
          output.push({ kind: "text", text: buffer.slice(0, emitLength) });
          buffer = buffer.slice(emitLength);
        }
        return output;
      }

      if (open.index > 0) {
        output.push({ kind: "text", text: buffer.slice(0, open.index) });
        buffer = buffer.slice(open.index);
      }

      const afterOpen = buffer.slice(open.token.length);
      const close = findEarliestStringToken(afterOpen, DEEPSEEK_DSML_TOOL_CLOSE_TOKENS);
      if (!close) {
        if (final) {
          output.push({ kind: "text", text: buffer });
          buffer = "";
        }
        return output;
      }

      const body = afterOpen.slice(0, close.index);
      const blockLength = open.token.length + close.index + close.token.length;
      const recoveredToolCalls = parseDeepSeekDsmlToolCallBlock(body);
      if (recoveredToolCalls.length > 0) {
        output.push(...recoveredToolCalls);
      } else {
        output.push({ kind: "text", text: buffer.slice(0, blockLength) });
      }
      buffer = buffer.slice(blockLength);
    }
    return output;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      return consume(false);
    },
    flush() {
      return consume(true);
    },
  };
}

export function parseDeepSeekDsmlToolCallBlock(body: string): RecoveredDeepSeekDsmlToolCall[] {
  const toolCalls: RecoveredDeepSeekDsmlToolCall[] = [];
  const invokeOpenRegex = /<[|｜]DSML[|｜]invoke\b([^>]*)>/g;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = invokeOpenRegex.exec(body)) !== null) {
    const invokeName = parseXmlAttribute(openMatch[1] ?? "", "name");
    if (!invokeName) {
      continue;
    }
    const invokeBodyStart = openMatch.index + openMatch[0].length;
    const invokeClose = findEarliestStringToken(body.slice(invokeBodyStart), [
      "</|DSML|invoke>",
      "</｜DSML｜invoke>",
    ]);
    if (!invokeClose) {
      continue;
    }
    const invokeBody = body.slice(invokeBodyStart, invokeBodyStart + invokeClose.index);
    invokeOpenRegex.lastIndex = invokeBodyStart + invokeClose.index + invokeClose.token.length;
    const parsedArguments = parseDeepSeekDsmlInvokeArguments(invokeBody);
    if (!parsedArguments) {
      continue;
    }
    toolCalls.push({
      kind: "toolCall",
      name: invokeName,
      arguments: parsedArguments,
      partialArgs: JSON.stringify(parsedArguments),
    });
  }
  return toolCalls;
}

export function parseDeepSeekDsmlInvokeArguments(body: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  const parameterRegex = /<[|｜]DSML[|｜]parameter\b([^>]*)>([\s\S]*?)<\/[|｜]DSML[|｜]parameter>/g;
  let parameterMatch: RegExpExecArray | null;
  while ((parameterMatch = parameterRegex.exec(body)) !== null) {
    const name = parseXmlAttribute(parameterMatch[1] ?? "", "name");
    if (!name) {
      continue;
    }
    const rawValue = parameterMatch[2] ?? "";
    if (rawValue.length === 0) {
      continue;
    }
    args[name] = decodeDeepSeekDsmlText(rawValue);
  }
  if (Object.keys(args).length > 0) {
    return args;
  }

  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && Object.keys(parsed).length > 0) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

// Cache compiled attribute matchers by name so the streaming parser does not
// recompile a RegExp on every chunk/parameter it scans.
export const xmlAttributeRegexCache = new Map<string, RegExp>();

export function xmlAttributeRegex(name: string): RegExp {
  const cached = xmlAttributeRegexCache.get(name);
  if (cached) {
    return cached;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}=("([^"]*)"|'([^']*)'|([^\\s>]+))`);
  xmlAttributeRegexCache.set(name, pattern);
  return pattern;
}

export function parseXmlAttribute(attributes: string, name: string): string | null {
  const match = xmlAttributeRegex(name).exec(attributes);
  const value = match?.[2] ?? match?.[3] ?? match?.[4];
  return value ? decodeDeepSeekDsmlText(value) : null;
}

export function decodeDeepSeekDsmlText(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function findEarliestStringToken(text: string, tokens: readonly string[]) {
  let best: { index: number; token: string } | null = null;
  for (const token of tokens) {
    const index = text.indexOf(token);
    if (index !== -1 && (!best || index < best.index)) {
      best = { index, token };
    }
  }
  return best;
}

export function longestDeepSeekDsmlToolOpenPrefixSuffixLength(text: string) {
  const maxLength = Math.min(text.length, DEEPSEEK_DSML_TOOL_MAX_OPEN_TOKEN_LEN - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = text.slice(text.length - length);
    if (DEEPSEEK_DSML_TOOL_OPEN_TOKENS.some((token) => token.startsWith(suffix))) {
      return length;
    }
  }
  return 0;
}
