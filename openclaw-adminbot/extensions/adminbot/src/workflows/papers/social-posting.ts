import type { AdminBotLabMember, AdminBotPaperRecord } from "../../contracts/actions.js";

export type AdminBotSocialPlatform = "linkedin" | "x";

export type AdminBotSocialResolvedTag = {
  member_id?: string;
  name: string;
  x_handle?: string;
  linkedin_tag?: string;
  linkedin_urn?: string;
};

export type AdminBotSocialMissingTag = {
  member_id?: string;
  name: string;
  platform: AdminBotSocialPlatform;
  reason: string;
};

export type AdminBotPaperSocialPayload = {
  action: "publish_paper_social_posts";
  platforms: AdminBotSocialPlatform[];
  paper: {
    id?: string;
    title: string;
    url?: string;
    summary: string;
    authors: string[];
  };
  tags: {
    resolved: AdminBotSocialResolvedTag[];
    missing: AdminBotSocialMissingTag[];
  };
  linkedin?: {
    text: string;
    visibility: "PUBLIC" | "CONNECTIONS";
  };
  x?: {
    posts: string[];
  };
};

export type AdminBotPaperSocialDraftInput = {
  paper?: AdminBotPaperRecord;
  paperId?: string;
  title?: string;
  summary: string;
  url?: string;
  authors?: string[];
  tone?: string;
  hashtags?: string[];
  platforms?: AdminBotSocialPlatform[];
  linkedinVisibility?: "PUBLIC" | "CONNECTIONS";
  members: AdminBotLabMember[];
};

const X_POST_LIMIT = 280;
const X_SEGMENT_LIMIT = 260;
const DEFAULT_SOCIAL_PLATFORMS: AdminBotSocialPlatform[] = ["linkedin", "x"];

export function buildPaperSocialPayload(
  input: AdminBotPaperSocialDraftInput,
): AdminBotPaperSocialPayload {
  const platforms = input.platforms?.length
    ? uniquePlatforms(input.platforms)
    : DEFAULT_SOCIAL_PLATFORMS;
  const paperTitle = requireNonEmpty(input.title ?? input.paper?.title, "paper title");
  const paperUrl =
    input.url ??
    firstPresent(
      input.paper?.artifacts?.arxiv_url,
      input.paper?.artifacts?.google_drive_pdf_url,
      input.paper?.artifacts?.submission_url,
    );
  const authors = normalizeAuthors(input.authors ?? input.paper?.authors ?? []);
  const tags = resolveAuthorTags(authors, input.members, platforms);
  const hashtagText = normalizeHashtags(input.hashtags).join(" ");
  const tonePrefix = input.tone ? `${input.tone.trim()} tone. ` : "";
  const tagLine = tags.resolved.length
    ? `Authors: ${tags.resolved.map((tag) => tag.linkedin_tag ?? tag.x_handle ?? tag.name).join(", ")}`
    : authors.length
      ? `Authors: ${authors.join(", ")}`
      : "";
  const linkLine = paperUrl ? `Read more: ${paperUrl}` : "";
  const linkedinText = compactLines([
    `${tonePrefix}New paper: ${paperTitle}`,
    input.summary,
    tagLine,
    hashtagText,
    linkLine,
  ]);
  const xSeed = compactLines([
    `New paper: ${paperTitle}`,
    input.summary,
    tags.resolved
      .map((tag) => tag.x_handle)
      .filter(Boolean)
      .join(" "),
    hashtagText,
    linkLine,
  ]);
  return {
    action: "publish_paper_social_posts",
    platforms,
    paper: {
      ...((input.paperId ?? input.paper?.id) ? { id: input.paperId ?? input.paper?.id } : {}),
      title: paperTitle,
      summary: input.summary.trim(),
      authors,
      ...(paperUrl ? { url: paperUrl } : {}),
    },
    tags,
    ...(platforms.includes("linkedin")
      ? { linkedin: { text: linkedinText, visibility: input.linkedinVisibility ?? "PUBLIC" } }
      : {}),
    ...(platforms.includes("x") ? { x: { posts: splitForX(xSeed) } } : {}),
  };
}

export function splitForX(text: string): string[] {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (countCodePoints(normalized) <= X_POST_LIMIT) {
    return [normalized];
  }
  const words = normalized.split(" ");
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (countCodePoints(candidate) <= X_SEGMENT_LIMIT) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (countCodePoints(word) > X_SEGMENT_LIMIT) {
      chunks.push(...splitLongToken(word));
    } else {
      current = word;
    }
  }
  if (current) {
    chunks.push(current);
  }
  const total = chunks.length;
  return chunks.map((chunk, index) => {
    const suffix = ` (${index + 1}/${total})`;
    const allowed = X_POST_LIMIT - countCodePoints(suffix);
    return `${truncateCodePoints(chunk, allowed)}${suffix}`;
  });
}

export function assertSocialPayloadReady(payload: AdminBotPaperSocialPayload): void {
  if (payload.tags.missing.length > 0) {
    const missing = payload.tags.missing
      .map((entry) => `${entry.name} ${entry.platform}: ${entry.reason}`)
      .join("; ");
    throw new Error(`social post is missing required tags: ${missing}`);
  }
  if (payload.platforms.includes("linkedin") && !payload.linkedin?.text.trim()) {
    throw new Error("linkedin post text is required");
  }
  if (payload.platforms.includes("x")) {
    const posts = payload.x?.posts ?? [];
    if (posts.length === 0) {
      throw new Error("at least one X post is required");
    }
    const tooLong = posts.find((post) => countCodePoints(post) > X_POST_LIMIT);
    if (tooLong) {
      throw new Error("X post exceeds the 280 character limit");
    }
  }
}

function resolveAuthorTags(
  authors: string[],
  members: AdminBotLabMember[],
  platforms: AdminBotSocialPlatform[],
): AdminBotPaperSocialPayload["tags"] {
  const resolved: AdminBotSocialResolvedTag[] = [];
  const missing: AdminBotSocialMissingTag[] = [];
  for (const author of authors) {
    const member = findMember(author, members);
    const notes = parseNotes(member?.notes);
    const xHandle = normalizeXHandle(firstPresent(notes.x, notes.twitter));
    const linkedinTag = firstPresent(notes.linkedin, notes.linkedin_url, notes.linkedin_tag);
    const linkedinUrn = firstPresent(notes.linkedin_urn, notes.linkedinurn);
    resolved.push({
      ...(member ? { member_id: member.id } : {}),
      name: member?.name ?? author,
      ...(xHandle ? { x_handle: xHandle } : {}),
      ...(linkedinTag ? { linkedin_tag: linkedinTag } : {}),
      ...(linkedinUrn ? { linkedin_urn: linkedinUrn } : {}),
    });
    if (platforms.includes("x") && !xHandle) {
      missing.push({
        ...(member ? { member_id: member.id } : {}),
        name: member?.name ?? author,
        platform: "x",
        reason: member
          ? "add an X: or Twitter: handle to member notes"
          : "author is not in the AdminBot member list",
      });
    }
    if (platforms.includes("linkedin") && !linkedinTag && !linkedinUrn) {
      missing.push({
        ...(member ? { member_id: member.id } : {}),
        name: member?.name ?? author,
        platform: "linkedin",
        reason: member
          ? "add a LinkedIn: tag/url or LinkedIn URN: to member notes"
          : "author is not in the AdminBot member list",
      });
    }
  }
  return { resolved, missing };
}

function findMember(author: string, members: AdminBotLabMember[]): AdminBotLabMember | undefined {
  const normalized = normalizeIdentity(author);
  return members.find(
    (member) =>
      normalizeIdentity(member.id) === normalized ||
      normalizeIdentity(member.name) === normalized ||
      normalizeIdentity(member.email ?? "") === normalized,
  );
}

function parseNotes(notes: string | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of (notes ?? "").split("\n")) {
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line
      .slice(0, separator)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_");
    const value = line.slice(separator + 1).trim();
    if (key && value) {
      values[key] = value;
    }
  }
  return values;
}

function normalizeXHandle(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /(?:x\.com\/|twitter\.com\/)?@?([A-Za-z0-9_]{1,15})/u.exec(trimmed);
  return match ? `@${match[1]}` : undefined;
}

function splitLongToken(token: string): string[] {
  const chars = [...token];
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += X_SEGMENT_LIMIT) {
    chunks.push(chars.slice(index, index + X_SEGMENT_LIMIT).join(""));
  }
  return chunks;
}

function truncateCodePoints(value: string, limit: number): string {
  return [...value].slice(0, limit).join("").trim();
}

function countCodePoints(value: string): number {
  return [...value].length;
}

function compactLines(lines: Array<string | undefined>): string {
  return lines
    .map((line) => line?.trim())
    .filter(Boolean)
    .join("\n\n");
}

function normalizeAuthors(authors: string[]): string[] {
  return authors.map((author) => author.trim()).filter(Boolean);
}

function normalizeHashtags(hashtags: string[] | undefined): string[] {
  return [...new Set((hashtags ?? []).map((tag) => tag.trim()).filter(Boolean))].map((tag) =>
    tag.startsWith("#") ? tag : `#${tag.replace(/^#+/u, "")}`,
  );
}

function uniquePlatforms(platforms: AdminBotSocialPlatform[]): AdminBotSocialPlatform[] {
  return [...new Set(platforms)];
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function firstPresent(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}
