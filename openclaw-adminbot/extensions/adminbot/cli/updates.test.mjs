import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkForCliUpdate, cliUpdateNotice, markCliUpdateNotified } from "./updates.mjs";

const release = (version, tag = `adminbot-cli-v${version}`) => ({
  tag_name: tag,
  html_url: `https://github.com/akhkim/adminbot/releases/tag/${tag}`,
  assets: [
    {
      name: `adminbot-cli-${version}.tgz`,
      browser_download_url: `https://github.com/akhkim/adminbot/releases/download/${tag}/adminbot-cli-${version}.tgz`,
    },
  ],
});

await test("update check picks the newest CLI asset and limits notices to weekly", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "adminbot-update-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "update-check.json");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => [release("0.2.0"), release("0.1.1"), release("0.3.0", "other-project")],
    };
  };
  const options = { currentVersion: "0.1.0", stateFile, fetchImpl };
  const first = await checkForCliUpdate({ ...options, now: 1_800_000_000_000 });
  assert.equal(first.update.version, "0.2.0");
  assert.equal(first.notify, true);
  assert.match(
    cliUpdateNotice(first.update),
    /npm install --global https:\/\/github\.com\/akhkim\/adminbot\/releases\/download\/adminbot-cli-v0\.2\.0\/adminbot-cli-0\.2\.0\.tgz/u,
  );
  await markCliUpdateNotified(stateFile, first.update.version, 1_800_000_000_000);
  const cached = await checkForCliUpdate({ ...options, now: 1_800_000_000_001 });
  assert.equal(calls, 1);
  assert.equal(cached.notify, false);
  const week = await checkForCliUpdate({
    ...options,
    now: 1_800_000_000_000 + 7 * 24 * 60 * 60 * 1000,
  });
  assert.equal(week.notify, true);
  assert.equal(calls, 2);
  const updated = await checkForCliUpdate({
    ...options,
    currentVersion: "0.2.0",
    now: 1_800_000_000_001,
  });
  assert.equal(updated.update, undefined);
  assert.equal(updated.notify, false);
  assert.equal((await readFile(stateFile, "utf8")).includes("0.2.0"), true);
});

await test("release failures and invalid asset URLs never block commands or show install instructions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "adminbot-update-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "update-check.json");
  const bad = release("9.0.0");
  bad.assets[0].browser_download_url = "https://evil.example/adminbot.tgz";
  const result = await checkForCliUpdate({
    currentVersion: "0.1.0",
    stateFile,
    force: true,
    fetchImpl: async () => ({ ok: true, json: async () => [bad] }),
  });
  assert.equal(result.update, undefined);
  const offline = await checkForCliUpdate({
    currentVersion: "0.1.0",
    stateFile,
    force: true,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(offline.unavailable, true);
  assert.equal(offline.notify, false);
});
