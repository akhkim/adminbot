/**
 * Attempt stage: pre-run policy and session-entry resolution.
 *
 * Work that happens before the prompt is built: collecting every layer that can
 * contribute an explicit tool allowlist (global, agent, group, sandbox, subagent,
 * inherited, runtime) in the order the guard reports them, checking whether a
 * plugin metadata snapshot already covers the run's provider, and applying
 * quota-resume TTL maintenance to just this attempt's session entry.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { loadSessionEntry, updateSessionEntry } from "../../../config/sessions/session-accessor.js";
import { resolveQuotaSuspensionEntryMaintenance } from "../../../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../subagents/subagent-capabilities.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../../tools/agent-tools.policy.js";
import { collectExplicitToolAllowlistSources } from "../../tools/tool-allowlist-guard.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function pluginMetadataSnapshotCoversProvider(
  snapshot: PluginMetadataSnapshot | undefined,
  provider: string,
): snapshot is PluginMetadataSnapshot {
  const normalizedProvider = normalizeProviderId(provider);
  if (!snapshot || !normalizedProvider) {
    return false;
  }
  return snapshot.manifestRegistry.plugins.some((plugin) => {
    const ownsProvider = plugin.providers.some(
      (providerId) => normalizeProviderId(providerId) === normalizedProvider,
    );
    if (ownsProvider) {
      return true;
    }
    const modelCatalogProviderIds = [
      ...Object.keys(plugin.modelCatalog?.providers ?? {}),
      ...Object.keys(plugin.modelCatalog?.aliases ?? {}),
    ];
    return modelCatalogProviderIds.some(
      (providerId) => normalizeProviderId(providerId) === normalizedProvider,
    );
  });
}

export function collectAttemptExplicitToolAllowlistSources(params: {
  config?: EmbeddedRunAttemptParams["config"];
  sessionKey?: string;
  sandboxSessionKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  sandboxToolPolicy?: { allow?: string[]; deny?: string[] };
  toolsAllow?: string[];
}) {
  const { agentId, globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy } =
    resolveEffectiveToolPolicy({
      config: params.config,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
    });
  const groupPolicy = resolveGroupToolPolicy({
    config: params.config,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.agentAccountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  const subagentStore = resolveSubagentCapabilityStore(params.sandboxSessionKey, {
    cfg: params.config,
  });
  const subagentPolicy =
    params.sandboxSessionKey &&
    isSubagentEnvelopeSession(params.sandboxSessionKey, {
      cfg: params.config,
      store: subagentStore,
    })
      ? resolveSubagentToolPolicyForSession(params.config, params.sandboxSessionKey, {
          store: subagentStore,
        })
      : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(
    params.config,
    params.sandboxSessionKey,
    {
      store: subagentStore,
    },
  );
  return collectExplicitToolAllowlistSources([
    { label: "tools.allow", allow: globalPolicy?.allow },
    { label: "tools.byProvider.allow", allow: globalProviderPolicy?.allow },
    {
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
      allow: agentPolicy?.allow,
    },
    {
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
      allow: agentProviderPolicy?.allow,
    },
    { label: "group tools.allow", allow: groupPolicy?.allow },
    { label: "sandbox tools.allow", allow: params.sandboxToolPolicy?.allow },
    { label: "subagent tools.allow", allow: subagentPolicy?.allow },
    { label: "inherited tools.allow", allow: inheritedToolPolicy?.allow },
    { label: "runtime toolsAllow", allow: params.toolsAllow, enforceWhenToolsDisabled: true },
  ]);
}

// Applies quota-resume TTL maintenance to only the active attempt session.
export async function loadAttemptSessionEntryAfterQuotaMaintenance(params: {
  storePath: string;
  sessionKey: string;
}): Promise<SessionEntry | undefined> {
  const entry = loadSessionEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });
  if (!entry?.quotaSuspension) {
    return entry;
  }
  const now = Date.now();
  const maintenance = resolveQuotaSuspensionEntryMaintenance({ entry, now });
  if (!maintenance.patch) {
    return entry;
  }
  const updated = await updateSessionEntry(
    {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    (currentEntry) =>
      resolveQuotaSuspensionEntryMaintenance({
        entry: currentEntry,
        now,
      }).patch,
    {
      skipMaintenance: true,
      takeCacheOwnership: true,
    },
  );
  return updated ?? entry;
}
