// Which topic channels a person belongs in.
//
// Rows 15 and 18 of the external-collaborator access design: #discussion-xxx for the broad topic,
// #meeting-xxx for the weekly themed meeting. The topic is the channel's own name -- the lab has
// already decided what its topics are by opening channels for them -- so this never invents one.
//
// Matching is deliberately conservative. Every token of the channel's topic has to appear in the
// person's vocabulary: #discussion-causal-inference needs both "causal" and "inference", not
// either. The looser rule reads better on paper and is worse in practice, because the failure it
// produces is a real person put in a room they have nothing to do with, which somebody then has to
// notice and undo. A missed match costs an invite that an admin can send by hand.
import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";

/** The channel families this matches. The prefix is stripped to leave the topic. */
export const ADMINBOT_TOPIC_CHANNEL_PREFIXES = ["discussion", "meeting"] as const;

export type AdminBotTopicChannelPrefix = (typeof ADMINBOT_TOPIC_CHANNEL_PREFIXES)[number];

/**
 * Words that carry no topic. Matching on these is how everybody ends up in every channel: a title
 * containing "model" would otherwise join #discussion-model-editing.
 *
 * Short tokens are dropped separately, below, which covers most of the rest.
 */
const STOPWORDS = new Set([
  "and",
  "for",
  "the",
  "with",
  "from",
  "into",
  "over",
  "using",
  "toward",
  "towards",
  "general",
  "generic",
  "misc",
  "other",
  "team",
  "group",
  "lab",
  "chat",
  "random",
  "active",
]);

/** Lowercase alphanumeric words of four characters or more, minus the stopwords. */
export function topicTokens(text: string): string[] {
  return [
    ...new Set(
      String(text ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter((token) => token.length >= 4 && !STOPWORDS.has(token)),
    ),
  ];
}

/** The topic a channel name carries, or null when it is not one of ours. */
export function topicOfChannel(
  channelName: string,
): { prefix: AdminBotTopicChannelPrefix; topic: string } | null {
  const name = String(channelName ?? "")
    .trim()
    .replace(/^#/u, "")
    .toLowerCase();
  for (const prefix of ADMINBOT_TOPIC_CHANNEL_PREFIXES) {
    if (name.startsWith(`${prefix}-`)) {
      const topic = name.slice(prefix.length + 1);
      return topic ? { prefix, topic } : null;
    }
  }
  return null;
}

/**
 * Everything the lab knows about what this person works on.
 *
 * Their stated research interests, and the projects they are actually on -- title and alias both,
 * because a project is as often known by its short name as its title, and the alias is frequently
 * the more topical of the two ("cais" says less than "Causal AI Scientist", but "alg-circuit" says
 * more than a title that leads with a method name).
 */
export function memberTopicVocabulary(
  member: AdminBotLabMember,
  papers: readonly AdminBotPaperRecord[],
): string[] {
  const parts: string[] = [...(member.research_topics ?? [])];
  for (const paper of papers) {
    const onIt = (paper.author_links ?? []).some((link) => link.member_id === member.id);
    if (!onIt) {
      continue;
    }
    parts.push(paper.title ?? "");
    if (paper.alias) {
      // Hyphens are separators, so an alias reads as its words rather than one long token.
      parts.push(paper.alias.replaceAll("-", " "));
    }
  }
  return [...new Set(parts.flatMap((part) => topicTokens(part)))];
}

/**
 * The channels this person belongs in, from the list of channels that exist.
 *
 * `channels` is what Slack currently has, not what anybody thinks it should have: the lab decides
 * its topics by opening channels, and a match against a channel that does not exist is an invite
 * that cannot be sent.
 */
export function matchTopicChannels(params: {
  member: AdminBotLabMember;
  papers: readonly AdminBotPaperRecord[];
  channels: readonly string[];
  /** Restrict to one family. Omitted matches both. */
  prefix?: AdminBotTopicChannelPrefix;
}): string[] {
  const vocabulary = new Set(memberTopicVocabulary(params.member, params.papers));
  if (vocabulary.size === 0) {
    return [];
  }
  const matched: string[] = [];
  for (const channel of params.channels) {
    const parsed = topicOfChannel(channel);
    if (!parsed || (params.prefix && parsed.prefix !== params.prefix)) {
      continue;
    }
    const wanted = topicTokens(parsed.topic);
    // A topic that reduces to nothing -- #discussion-misc, say -- matches nobody rather than
    // everybody. An empty `every` is vacuously true, which is the wrong answer here.
    if (wanted.length === 0) {
      continue;
    }
    if (wanted.every((token) => vocabulary.has(token))) {
      matched.push(channel.replace(/^#/u, "").toLowerCase());
    }
  }
  return [...new Set(matched)].toSorted((left, right) => left.localeCompare(right));
}
