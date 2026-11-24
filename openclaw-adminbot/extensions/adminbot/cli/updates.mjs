import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RELEASES_URL = "https://api.github.com/repos/akhkim/adminbot/releases?per_page=10";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOTICE_INTERVAL_MS = 7 * CHECK_INTERVAL_MS;

function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    return undefined;
  }
  return version.split(".").map(Number);
}

function newer(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return left[index] > right[index];
    }
  }
  return false;
}

function safeUpdate(update, currentVersion) {
  if (!update || !newer(update.version, currentVersion)) {
    return undefined;
  }
  try {
    const releaseUrl = new URL(update.releaseUrl);
    const assetUrl = new URL(update.url);
    if (releaseUrl.origin !== "https://github.com" || assetUrl.origin !== releaseUrl.origin) {
      return undefined;
    }
    const releasePath = releaseUrl.pathname.match(/^\/akhkim\/adminbot\/releases\/tag\/([^/]+)$/u);
    if (
      !releasePath ||
      assetUrl.pathname !==
        `/akhkim/adminbot/releases/download/${releasePath[1]}/adminbot-cli-${update.version}.tgz`
    ) {
      return undefined;
    }
    return update;
  } catch {
    return undefined;
  }
}

function latestCliRelease(releases, currentVersion) {
  if (!Array.isArray(releases)) {
    return undefined;
  }
  let best;
  for (const release of releases) {
    if (release?.draft || !Array.isArray(release?.assets)) {
      continue;
    }
    if (typeof release.tag_name !== "string" || !release.tag_name.startsWith("adminbot-cli-")) {
      continue;
    }
    if (
      !/^https:\/\/github\.com\/akhkim\/adminbot\/releases\/tag\/[^/]+$/u.test(
        release.html_url ?? "",
      )
    ) {
      continue;
    }
    for (const asset of release.assets) {
      const match = /^adminbot-cli-(\d+\.\d+\.\d+)\.tgz$/u.exec(asset?.name ?? "");
      if (!match || !newer(match[1], currentVersion) || (best && !newer(match[1], best.version))) {
        continue;
      }
      const url = asset.browser_download_url;
      if (
        url !==
        `https://github.com/akhkim/adminbot/releases/download/${encodeURIComponent(release.tag_name)}/${asset.name}`
      ) {
        continue;
      }
      best = { version: match[1], url, releaseUrl: release.html_url };
    }
  }
  return best;
}

export async function checkForCliUpdate({
  currentVersion,
  fetchImpl = globalThis.fetch,
  stateFile = join(homedir(), ".config", "adminbot", "update-check.json"),
  now = Date.now(),
  force = false,
}) {
  let state = {};
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    // A missing or damaged cache only means the release feed is checked again.
  }
  state.update = safeUpdate(state.update, currentVersion);
  if (!force && now - state.checkedAt < CHECK_INTERVAL_MS) {
    return {
      update: state.update,
      notify: Boolean(state.update && now - (state.notifiedAt ?? 0) >= NOTICE_INTERVAL_MS),
    };
  }
  let update;
  try {
    const response = await fetchImpl(RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `adminbot-cli/${currentVersion}`,
      },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      throw new Error("release feed unavailable");
    }
    update = latestCliRelease(await response.json(), currentVersion);
  } catch {
    // A release check must never fail or slow down the user's actual command.
    return { update: state.update, notify: false, unavailable: true };
  }
  const next = {
    checkedAt: now,
    update,
    notifiedAt: state.update?.version === update?.version ? state.notifiedAt : 0,
  };
  let saved = false;
  try {
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    await writeFile(stateFile, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    saved = true;
  } catch {
    // A read-only home should not stop AdminBot commands.
  }
  return {
    update,
    notify: Boolean(saved && update && now - (next.notifiedAt ?? 0) >= NOTICE_INTERVAL_MS),
  };
}

export async function markCliUpdateNotified(stateFile, version, now = Date.now()) {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (state.update?.version !== version) {
      return;
    }
    await writeFile(stateFile, `${JSON.stringify({ ...state, notifiedAt: now })}\n`, {
      mode: 0o600,
    });
  } catch {
    // The next command may repeat a notice when the cache cannot be saved.
  }
}

export function cliUpdateNotice(update) {
  return `AdminBot CLI ${update.version} is available. Changes: ${update.releaseUrl}\nUpdate: npm install --global ${update.url}\n`;
}

export function cliUpdateStateFile(env) {
  return (
    env.ADMINBOT_UPDATE_STATE_FILE ?? join(homedir(), ".config", "adminbot", "update-check.json")
  );
}
