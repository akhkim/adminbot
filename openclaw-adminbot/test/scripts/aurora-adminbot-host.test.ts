import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const hostScript = path.join(root, "scripts/aurora-adminbot-host.sh");
const installer = path.join(root, "deploy/aurora/install-user-services.sh");
const sheetPollerInstaller = path.join(root, "deploy/aurora/install-member-sheet-poller.sh");

describe("Aurora AdminBot hosting", () => {
  it("keeps both shell entrypoints syntactically valid", () => {
    expect(() =>
      execFileSync("bash", ["-n", hostScript, installer, sheetPollerInstaller]),
    ).not.toThrow();
  });

  it("deploys committed revisions and keeps services stopped until explicit start", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    expect(script).toContain('git -C "$REPO_ROOT" archive');
    expect(script).toContain("--no-start");
    expect(script).toContain('-L "${GATEWAY_PORT}:127.0.0.1:${GATEWAY_PORT}"');
    expect(script).toContain('-L "${ADMINBOT_PORT}:127.0.0.1:${ADMINBOT_PORT}"');
  });

  it("can merge Slack secrets without replacing unrelated Aurora secrets", () => {
    const script = fs.readFileSync(hostScript, "utf8");
    expect(script).toContain("sync-slack-env");
    expect(script).toContain("SLACK_BOT_TOKEN is missing or empty");
    expect(script).toContain("SLACK_APP_TOKEN is missing or empty");
    expect(script).toContain("grep -vE '^SLACK_(BOT|APP|USER)_TOKEN='");
    expect(script).toContain("systemctl --user restart jinesis-openclaw-gateway.service");
  });

  it("syncs OpenClaw cron through Gateway RPC and disables the duplicate systemd timer", () => {
    const host = fs.readFileSync(hostScript, "utf8");
    const script = fs.readFileSync(installer, "utf8");
    expect(host).toContain("sync-cron-jobs");
    expect(host).toContain("export-openclaw-cron-jobs.mjs");
    expect(host).toContain("import-openclaw-cron-jobs.mjs");
    expect(host).toContain("cron list --all --json");
    expect(host).toContain("disable --now jinesis-adminbot-email.timer");
    expect(script).toContain("gateway run --bind loopback");
    expect(script).toContain("jinesis-vllm.service");
    expect(script).toContain("disable --now jinesis-adminbot-email.timer");
    expect(script).not.toContain("OnCalendar=hourly");
    expect(script).toContain("grep -q 'REPLACE_ME'");
    expect(script).toContain("gmail labels list");
    expect(script).toContain("ADMINBOT_LOCAL_BASE_URL");
    expect(script).toContain('"${ADMINBOT_LOCAL_BASE_URL%/}/models"');
    expect(script).toContain("Slack is enabled but SLACK_BOT_TOKEN is missing");
    expect(script).toContain("Slack socket mode is enabled but SLACK_APP_TOKEN is missing");
    expect(script).toContain("install-member-sheet-poller.sh");
    const poller = fs.readFileSync(sheetPollerInstaller, "utf8");
    expect(poller).toContain("jinesis-adminbot-sheet-poller.timer");
    expect(poller).toContain('adminbot-member-sheet-poller.ts" --dry-run');
    expect(poller).toContain("OnUnitActiveSec=$INTERVAL");
  });
});
