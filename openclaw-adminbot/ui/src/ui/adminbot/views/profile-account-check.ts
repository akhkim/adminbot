// Liveness checks for the account links on the member profile page ("does this GitHub user /
// OpenReview id actually exist"), as distinct from the shape checks the server already runs on
// every save (SOCIAL_URL_FIELDS in extensions/adminbot/src/kernel/service.ts). A live check means
// an outbound fetch per keystroke-pause, and the two platforms below are the only ones where that
// fetch is both safe and reliable:
//   - GitHub's REST API is public, unauthenticated, CORS-enabled, and does not rate-limit a
//     handful of self-edit saves into trouble.
//   - OpenReview's API is likewise public and CORS-enabled, and the id format the server already
//     enforces (~First_Last1) makes the lookup a single well-formed GET.
// Twitter/X and LinkedIn require an authenticated API and/or block programmatic requests outright
// (bot detection, login walls), so a "does this account exist" fetch against them from a browser
// is unreliable in exactly the way that makes false "account not found" errors worse than no
// check at all. Those fields get the format check only; this module never touches them.
export type ProfileAccountCheckStatus = "checking" | "verified" | "not-found" | "unknown";

export type ProfileAccountCheck = {
  status: ProfileAccountCheckStatus;
  message?: string;
};

const GITHUB_USERNAME = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/?$/u;
const OPENREVIEW_ID = /^~[A-Za-z][A-Za-z0-9_.]*[0-9]$/u;

function extractGithubUsername(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["github.com", "www.github.com"].includes(parsed.hostname)) {
      return null;
    }
    const match = GITHUB_USERNAME.exec(parsed.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Checkable fields only -- everything else (twitter_url, linkedin_url, scholar_url,
// personal_website, cv_url) is format-validated server-side and left alone here.
export type CheckableField = "github_url" | "openreview_id";

export function isCheckableField(field: string): field is CheckableField {
  return field === "github_url" || field === "openreview_id";
}

async function checkGithubAccount(url: string, signal: AbortSignal): Promise<ProfileAccountCheck> {
  const username = extractGithubUsername(url);
  if (!username) {
    // Shape is already rejected server-side; nothing useful to report here.
    return { status: "unknown" };
  }
  try {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
      signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (response.status === 404) {
      return { status: "not-found", message: `No GitHub account found for "${username}".` };
    }
    if (!response.ok) {
      // Rate-limited or GitHub is having a bad day -- don't turn that into a false rejection.
      return { status: "unknown" };
    }
    return { status: "verified" };
  } catch {
    return { status: "unknown" };
  }
}

async function checkOpenReviewAccount(
  id: string,
  signal: AbortSignal,
): Promise<ProfileAccountCheck> {
  const trimmed = id.trim();
  if (!OPENREVIEW_ID.test(trimmed)) {
    return { status: "unknown" };
  }
  try {
    const response = await fetch(
      `https://api2.openreview.net/profiles?id=${encodeURIComponent(trimmed)}`,
      { signal },
    );
    if (!response.ok) {
      return { status: "unknown" };
    }
    const data = (await response.json()) as { profiles?: unknown[] };
    if (!Array.isArray(data.profiles) || data.profiles.length === 0) {
      return { status: "not-found", message: `No OpenReview profile found for "${trimmed}".` };
    }
    return { status: "verified" };
  } catch {
    return { status: "unknown" };
  }
}

export function checkAccount(
  field: CheckableField,
  value: string,
  signal: AbortSignal,
): Promise<ProfileAccountCheck> {
  if (!value.trim()) {
    return Promise.resolve({ status: "unknown" });
  }
  return field === "github_url"
    ? checkGithubAccount(value, signal)
    : checkOpenReviewAccount(value, signal);
}
