/**
 * Agent tool factory policy helpers.
 *
 * Was the optional media-tool factory planner. The media tools it planned for (image, video,
 * music, pdf) went with the media generation and understanding subsystems; what remains is the
 * generic allow/deny policy merging the tool factory still uses for every tool.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";

function isToolAllowedByFactoryPolicy(params: {
  toolName: string;
  allowlist?: string[];
  denylist?: string[];
}): boolean {
  return isToolAllowedByPolicyName(params.toolName, {
    allow: params.allowlist,
    deny: params.denylist,
  });
}

/** Returns true only when an allowlist explicitly enables the requested tool. */
export function isToolExplicitlyAllowedByFactoryPolicy(params: {
  toolName: string;
  allowlist?: string[];
  denylist?: string[];
}): boolean {
  if (!params.allowlist?.some((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    return false;
  }
  return isToolAllowedByFactoryPolicy(params);
}

/** Merges factory policy lists while preserving stable unique entries. */
export function mergeFactoryPolicyList(
  ...lists: Array<string[] | undefined>
): string[] | undefined {
  const merged = lists.flatMap((list) => (Array.isArray(list) ? list : []));
  return merged.length > 0 ? uniqueStrings(merged) : undefined;
}
