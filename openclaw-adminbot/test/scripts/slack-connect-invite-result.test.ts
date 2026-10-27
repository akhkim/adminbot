import { describe, expect, it } from "vitest";
import { readSlackConnectInviteResult } from "../../scripts/slack-connect-invite-result.mjs";

const run = (stdout: string, extra: Record<string, unknown> = {}) => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  ...extra,
});

describe("Slack Connect invite result", () => {
  it("returns the shareable link", () => {
    expect(
      readSlackConnectInviteResult(run('{"ok":true,"url":"https://join.slack.com/x"}\n')),
    ).toEqual({ url: "https://join.slack.com/x" });
  });

  it("accepts an invite delivered straight to an existing Slack account", () => {
    // Slack returns only an invite id here; the person was invited, so this is not a failure.
    expect(readSlackConnectInviteResult(run('{"ok":true,"url":"","invite_id":"I0123"}'))).toEqual({
      url: "",
      inviteId: "I0123",
    });
  });

  it("refuses a success with neither a link nor an invite id", () => {
    expect(() => readSlackConnectInviteResult(run('{"ok":true,"url":""}'))).toThrow(
      "without an invite url or invite id",
    );
  });

  it("passes the helper's own error through", () => {
    expect(() =>
      readSlackConnectInviteResult(run('{"ok":false,"error":"not_in_channel"}', { code: 1 })),
    ).toThrow("not_in_channel");
  });

  it("names a timeout kill instead of failing on an undefined signal", () => {
    // This branch used to read an unbound `signal` and threw "signal is not defined".
    expect(() => readSlackConnectInviteResult(run("", { code: null, signal: "SIGTERM" }))).toThrow(
      "produced no result: killed by SIGTERM (timed out?)",
    );
  });

  it("falls back to the last stderr line, then the exit code", () => {
    expect(() =>
      readSlackConnectInviteResult(run("", { code: 1, stderr: "warn\nTypeError: boom\n" })),
    ).toThrow("produced no result: TypeError: boom");
    expect(() => readSlackConnectInviteResult(run("", { code: 7 }))).toThrow(
      "produced no result: exit 7",
    );
  });

  it("reports a spawn failure", () => {
    expect(() =>
      readSlackConnectInviteResult(run("", { spawnError: new Error("spawn tsx ENOENT") })),
    ).toThrow("spawn tsx ENOENT");
  });

  it("reports stray non-JSON output rather than a bare SyntaxError", () => {
    expect(() => readSlackConnectInviteResult(run("(node:1) ExperimentalWarning: x"))).toThrow(
      "something other than JSON: (node:1) ExperimentalWarning",
    );
  });
});
