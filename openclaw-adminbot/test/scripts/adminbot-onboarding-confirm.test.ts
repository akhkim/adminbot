import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The confirm poller closes the onboarding-nudge loop from cron: it reads real DMs and
// writes real roster state, so its decisions are pinned here with both transports faked.
// Same subprocess-JSON pattern as adminbot-deadlines-lib.test.ts.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptsDir = path.join(repoRoot, "scripts");

// Fixed "now" plus a scenario harness: fake AdminBot + Slack transports that record
// every call, so each test asserts the report AND the side effects that would have
// hit real people.
const preamble = [
  "import json, sys",
  `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
  "from adminbot_onboarding_confirm import AdminBotApi, SlackDm, poll_step",
  "NOW = 1786000000.0",
  "DAY = 86400.0",
  "MESSAGE = 'Quick reminder: *Connect on LinkedIn* is still outstanding on your lab onboarding.'",
  "def nudge(ts, reactions=None, text=MESSAGE):",
  "    entry = {'ts': str(ts), 'bot_id': 'B1', 'text': text}",
  "    if reactions is not None:",
  "        entry['reactions'] = reactions",
  "    return entry",
  "def scenario(members, histories, live, cadence_days=3.0):",
  "    api_calls, slack_calls = [], []",
  "    def api_transport(method, url, headers, payload=None):",
  "        api_calls.append({'method': method, 'url': url, 'payload': payload})",
  "        if url.endswith('/pending'):",
  "            return {'step_id': 'linkedin', 'message': MESSAGE, 'members': members}",
  "        return {}",
  "    def slack_transport(method, url, headers, payload=None):",
  "        slack_calls.append({'url': url, 'payload': payload})",
  "        if url.endswith('conversations.open'):",
  "            return {'ok': True, 'channel': {'id': 'D-' + payload['users']}}",
  "        if url.endswith('conversations.history'):",
  "            return {'ok': True, 'messages': histories.get(payload['channel'], [])}",
  "        return {'ok': True}",
  "    api = AdminBotApi('http://adminbot.test', 'service-token', transport=api_transport)",
  "    slack = SlackDm('xoxb-test', transport=slack_transport)",
  "    report = poll_step(api, slack, 'linkedin', cadence_days, NOW, live)",
  "    posts = [c['payload'] for c in slack_calls if c['url'].endswith('chat.postMessage')]",
  "    writes = [c['url'] for c in api_calls if c['method'] == 'POST']",
  "    return {'report': report, 'posts': posts, 'writes': writes}",
].join("\n");

function runPython(body: string): {
  report: {
    mode: string;
    counts: Record<string, number>;
    outcomes: Array<{ member_id: string; status: string; reason: string }>;
  };
  posts: Array<{ channel: string; text: string }>;
  writes: string[];
} {
  const stdout = execFileSync("python3", ["-c", `${preamble}\n${body}`], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

describe("adminbot_onboarding_confirm.poll_step", () => {
  it("marks the step complete when the member reacted ✅ to the newest nudge", () => {
    const result = runPython(
      "print(json.dumps(scenario([{'id': 'sam', 'name': 'Sam', 'slack_user_id': 'U1'}]," +
        " {'D-U1': [nudge(NOW - DAY, reactions=[{'name': 'white_check_mark', 'users': ['U1']}])]}," +
        " live=True)))",
    );
    expect(result.report.outcomes).toMatchObject([{ member_id: "sam", status: "confirmed" }]);
    expect(result.writes).toEqual(["http://adminbot.test/lab/members/sam/onboarding/linkedin"]);
    // The member gets visible feedback in the DM so they know the reaction landed.
    expect(result.posts).toMatchObject([{ channel: "D-U1", text: expect.stringContaining("✅") }]);
  });

  it("accepts 👍 too, but never someone else's reaction", () => {
    const result = runPython(
      "print(json.dumps(scenario(" +
        "[{'id': 'sam', 'name': 'Sam', 'slack_user_id': 'U1'}, {'id': 'kai', 'name': 'Kai', 'slack_user_id': 'U2'}]," +
        " {'D-U1': [nudge(NOW - DAY, reactions=[{'name': '+1', 'users': ['U1']}])]," +
        "  'D-U2': [nudge(NOW - DAY, reactions=[{'name': 'white_check_mark', 'users': ['U9']}])]}," +
        " live=True)))",
    );
    expect(result.report.counts).toEqual({ confirmed: 1, waiting: 1 });
    expect(result.writes).toEqual(["http://adminbot.test/lab/members/sam/onboarding/linkedin"]);
  });

  it("waits inside the cadence window and re-nudges once it has elapsed", () => {
    const result = runPython(
      "print(json.dumps(scenario(" +
        "[{'id': 'sam', 'name': 'Sam', 'slack_user_id': 'U1'}, {'id': 'kai', 'name': 'Kai', 'slack_user_id': 'U2'}]," +
        " {'D-U1': [nudge(NOW - DAY)]," +
        "  'D-U2': [nudge(NOW - 5 * DAY)]}," +
        " live=True)))",
    );
    expect(result.report.outcomes).toMatchObject([
      { member_id: "sam", status: "waiting" },
      { member_id: "kai", status: "renudged" },
    ]);
    // The re-nudge is the service's own wording from the pending payload, not a local copy.
    expect(result.posts).toMatchObject([
      { channel: "D-U2", text: expect.stringContaining("Connect on LinkedIn") },
    ]);
    expect(result.writes).toEqual([]);
  });

  it("re-nudges a member with no nudge in the DM, ignoring the bot's other messages", () => {
    const result = runPython(
      "print(json.dumps(scenario([{'id': 'sam', 'name': 'Sam', 'slack_user_id': 'U1'}]," +
        // A deadline reminder (no marker phrase) and a human message must not count as nudges.
        " {'D-U1': [nudge(NOW - DAY, text='🔴 EMNLP due in 2 days')," +
        "           {'ts': str(NOW - DAY), 'user': 'U1', 'text': 'hey lab onboarding question'}]}," +
        " live=True)))",
    );
    expect(result.report.outcomes).toMatchObject([
      { member_id: "sam", status: "renudged", reason: "no nudge in DM history" },
    ]);
    expect(result.posts).toHaveLength(1);
  });

  it("skips members without a slack_user_id instead of failing the run", () => {
    const result = runPython(
      "print(json.dumps(scenario([{'id': 'noslack', 'name': 'No Slack'}], {}, live=True)))",
    );
    expect(result.report.outcomes).toMatchObject([{ member_id: "noslack", status: "skipped" }]);
    expect(result.posts).toEqual([]);
    expect(result.writes).toEqual([]);
  });

  it("dry-run reports the same decisions but sends and records nothing", () => {
    const result = runPython(
      "print(json.dumps(scenario(" +
        "[{'id': 'sam', 'name': 'Sam', 'slack_user_id': 'U1'}, {'id': 'kai', 'name': 'Kai', 'slack_user_id': 'U2'}]," +
        " {'D-U1': [nudge(NOW - DAY, reactions=[{'name': 'white_check_mark', 'users': ['U1']}])]," +
        "  'D-U2': [nudge(NOW - 5 * DAY)]}," +
        " live=False)))",
    );
    expect(result.report.mode).toBe("dry-run");
    expect(result.report.counts).toEqual({ confirmed: 1, renudged: 1 });
    expect(result.posts).toEqual([]);
    expect(result.writes).toEqual([]);
  });
});
