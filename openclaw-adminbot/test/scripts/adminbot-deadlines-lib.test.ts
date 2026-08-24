import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The deadline scripts fire real Slack DMs from cron and had no tests at all.
// These exercise the shared library (scripts/adminbot_deadlines.py) and the two
// runners' pure decision functions by importing them in a subprocess and
// printing JSON back, which is how the reimbursement helper is already tested.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptsDir = path.join(repoRoot, "scripts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runPython(body: string): unknown {
  const preamble = [
    "import json, sys, importlib.util",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "from adminbot_deadlines import AoEClock, DeadlineDataset, SlackNotifier, urgency_marker, archival_status_of, entry_type_of, venue_priority_of, WORKSHOP_FAMILIES",
    "def load(name):",
    `    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ${JSON.stringify(scriptsDir)} + '/' + name + '.py')`,
    "    module = importlib.util.module_from_spec(spec)",
    "    spec.loader.exec_module(module)",
    "    return module",
  ].join("\n");
  const stdout = execFileSync("python3", ["-c", `${preamble}\n${body}`], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

function datasetDir(venues: Array<Record<string, unknown>>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-deadlines-test-"));
  temporaryDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, "venues.json"),
    JSON.stringify({ timezone: "AoE (UTC-12)", count: venues.length, items: venues }),
  );
  return directory;
}

const venue = (id: string, deadline: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Venue ${id}`,
  venue_type: "conference",
  venue_group: "Group",
  deadline_label: "submission",
  deadline_aoe: deadline,
  ...extra,
});

describe("AoEClock", () => {
  it("treats an AoE stamp as expiring twelve hours later in UTC", () => {
    expect(
      runPython("print(json.dumps(AoEClock.instant('2026-08-29 23:59:59').isoformat()))"),
    ).toBe("2026-08-30T11:59:59+00:00");
  });

  // Every venue uses a 23:59:59 stamp, so the instant always lands on the next
  // calendar day. Reporting that day to an author moves their deadline.
  it("reports the AoE calendar date rather than the shifted UTC date", () => {
    expect(
      runPython(
        "print(json.dumps({'label': AoEClock.calendar_label('2026-08-29 23:59:59'), " +
          "'date': AoEClock.calendar_date('2026-08-29 23:59:59').isoformat(), " +
          "'instant_date': AoEClock.instant('2026-08-29 23:59:59').date().isoformat()}))",
      ),
    ).toEqual({ label: "Aug 29", date: "2026-08-29", instant_date: "2026-08-30" });
  });

  it("counts whole days remaining and detects a passed deadline", () => {
    expect(
      runPython(
        "c = AoEClock.resolve('2026-08-04')\n" +
          "print(json.dumps({'days': c.days_until('2026-08-29 23:59:59'), " +
          "'passed': c.has_passed('2026-08-01 23:59:59'), " +
          "'future': c.has_passed('2026-08-29 23:59:59')}))",
      ),
    ).toEqual({ days: 25, passed: true, future: false });
  });

  it("fires a cadence step on exactly one day", () => {
    // T-30 for an Aug 29 AoE deadline lands on Jul 31 (instant is Aug 30 UTC).
    expect(
      runPython(
        "days = [d for d in ['2026-07-30', '2026-07-31', '2026-08-01'] " +
          "if AoEClock.resolve(d).is_cadence_day('2026-08-29 23:59:59', 30)]\n" +
          "print(json.dumps(days))",
      ),
    ).toEqual(["2026-07-31"]);
  });

  it("prefers an explicit date over the ADMINBOT_DEADLINE_NOW override", () => {
    expect(
      runPython(
        "import os\n" +
          "os.environ['ADMINBOT_DEADLINE_NOW'] = '2026-01-01'\n" +
          "print(json.dumps([AoEClock.resolve('2026-08-04').today.isoformat(), " +
          "AoEClock.resolve(None).today.isoformat()]))",
      ),
    ).toEqual(["2026-08-04", "2026-01-01"]);
  });
});

describe("urgency_marker", () => {
  it("escalates as the deadline approaches and shares the Control UI bands", () => {
    expect(
      runPython("print(json.dumps([urgency_marker(d) for d in [0, 3, 4, 7, 8, 30, 31]]))"),
    ).toEqual(["🔴", "🔴", "🟠", "🟠", "🟡", "🟡", "🟢"]);
  });
});

describe("venue classification", () => {
  it("keeps entry type, archival status, and priority independent", () => {
    expect(
      runPython(
        "print(json.dumps({" +
          "'primary': [entry_type_of('conference', 'main'), archival_status_of('ACL', 'main'), venue_priority_of('ACL', 'main')], " +
          "'secondary': [entry_type_of('conference', 'demo'), archival_status_of('AACL', 'demo'), venue_priority_of('AACL', 'demo')], " +
          "'workshop': [entry_type_of('workshop', 'workshop'), archival_status_of('ACL', 'workshop'), venue_priority_of('ACL', 'workshop')], " +
          "'unknown': archival_status_of('Unlisted', 'main'), " +
          "'explicit_non_archival': archival_status_of('IASEAI', 'main')}))",
      ),
    ).toEqual({
      primary: ["main_conference", "archival", "primary"],
      secondary: ["demo_track", "archival", "secondary"],
      workshop: ["workshop", "unknown", "standard"],
      unknown: "unknown",
      explicit_non_archival: "non_archival",
    });
  });

  it("does not derive the workshop sweep from ARR or archival families", () => {
    expect(runPython("print(json.dumps(list(WORKSHOP_FAMILIES)))")).toEqual([
      "ACL",
      "EMNLP",
      "NAACL",
      "EACL",
      "NeurIPS",
      "ICML",
      "ICLR",
      "COLM",
    ]);
  });
});

describe("DeadlineDataset.upcoming", () => {
  it("returns only venues inside the window, soonest first", () => {
    const directory = datasetDir([
      venue("late", "2026-12-01 23:59:59"),
      venue("soon", "2026-08-10 23:59:59"),
      venue("passed", "2026-07-01 23:59:59"),
      venue("mid", "2026-08-20 23:59:59"),
    ]);

    expect(
      runPython(
        `d = DeadlineDataset(${JSON.stringify(directory)})\n` +
          "print(json.dumps([v['id'] for v in d.upcoming(AoEClock.resolve('2026-08-04'), 45)]))",
      ),
    ).toEqual(["soon", "mid"]);
  });

  it("excludes a deadline that has already expired today", () => {
    const directory = datasetDir([venue("today", "2026-08-03 23:59:59")]);

    expect(
      runPython(
        `d = DeadlineDataset(${JSON.stringify(directory)})\n` +
          "print(json.dumps([v['id'] for v in d.upcoming(AoEClock.resolve('2026-08-04'), 45)]))",
      ),
    ).toEqual([]);
  });
});

describe("SlackNotifier", () => {
  it("sends nothing unless delivery is explicitly enabled", () => {
    expect(
      runPython(
        "calls = []\n" +
          "n = SlackNotifier(send=False, cli='cli.mjs', runner=lambda *a, **k: calls.append(a))\n" +
          "sent = n.send('#chan', 'hello')\n" +
          "print(json.dumps({'sent': sent, 'calls': len(calls), 'delivered': n.delivered, 'mode': n.mode}))",
      ),
    ).toEqual({ sent: false, calls: 0, delivered: 0, mode: "dry-run" });
  });

  it("shells the OpenClaw CLI with a user target when delivery is enabled", () => {
    expect(
      runPython(
        "calls = []\n" +
          "n = SlackNotifier(send=True, cli='cli.mjs', runner=lambda argv, **k: calls.append(argv))\n" +
          "n.send_to_user('U123', 'ping')\n" +
          "print(json.dumps({'argv': calls[0], 'delivered': n.delivered, 'mode': n.mode}))",
      ),
    ).toEqual({
      argv: [
        "node",
        "cli.mjs",
        "message",
        "send",
        "--channel",
        "slack",
        "--target",
        "user:U123",
        "--message",
        "ping",
        "--json",
      ],
      delivered: 1,
      mode: "SEND",
    });
  });
});

describe("deadline digest message", () => {
  it("lists conferences individually and collapses the shared workshop deadline", () => {
    const directory = datasetDir([
      venue("conf", "2026-08-10 23:59:59", { name: "EMNLP 2026", link: "https://emnlp.example" }),
      venue("ws1", "2026-08-29 23:59:59", {
        venue_type: "workshop",
        venue_group: "NeurIPS 2026 Workshops",
        name: "WS One",
      }),
      venue("ws2", "2026-08-29 23:59:59", {
        venue_type: "workshop",
        venue_group: "NeurIPS 2026 Workshops",
        name: "WS Two",
      }),
      venue("ws3", "2026-08-20 23:59:59", {
        venue_type: "workshop",
        venue_group: "Other 2026 Workshops",
        name: "Lone Workshop",
      }),
    ]);

    const message = runPython(
      "m = load('adminbot-deadline-channel-digest')\n" +
        "c = AoEClock.resolve('2026-08-04')\n" +
        `v = DeadlineDataset(${JSON.stringify(directory)}).upcoming(c, 45)\n` +
        "print(json.dumps(m.build_message(v, c, 45)))",
    ) as string;

    expect(message).toContain("🟠 *Aug 10* (6d) — EMNLP 2026  <https://emnlp.example|↗>");
    // Collapsing keys off the dataset's venue_group, so the line names whichever series shares
    // the date and a series of one still shows under its own name.
    expect(message).toContain("*2 NeurIPS 2026 Workshops* (unified deadline)");
    expect(message).not.toContain("WS Two");
    expect(message).toContain("— Lone Workshop");
  });

  it("returns nothing when the window is empty, so cron posts no message", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-channel-digest')\n" +
          "print(json.dumps(m.build_message([], AoEClock.resolve('2026-08-04'), 45)))",
      ),
    ).toBeNull();
  });
});

describe("deadline reminder cadence", () => {
  it("nudges only confirmed rows, so a fuzzy workshop match never DMs on its own", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-reminders')\n" +
          "matches = {'ongoing': [{'title': 'A', 'confirmed': True}, {'title': 'B'}], " +
          "'ready': [{'title': 'C', 'confirmed': True}, {'title': 'D', 'confirmed': False}]}\n" +
          "print(json.dumps([p['title'] for p in m.confirmed_papers(matches)]))",
      ),
    ).toEqual(["A", "C"]);
  });

  // Steps are measured from the deadline instant (AoE + 12h), so T-N lands N days
  // before Aug 30 UTC — one day later than naive arithmetic on the Aug 29 AoE date.
  it("fires one cadence step per day and stays silent in between", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-reminders')\n" +
          "paper = {'deadline_aoe': '2026-08-29 23:59:59'}\n" +
          "out = {d: m.due_cadence_step(paper, AoEClock.resolve(d)) " +
          "for d in ['2026-07-31', '2026-08-15', '2026-08-22', '2026-08-23', " +
          "'2026-08-29', '2026-08-30']}\n" +
          "print(json.dumps(out))",
      ),
    ).toEqual({
      "2026-07-31": 30,
      "2026-08-15": 15,
      "2026-08-22": null,
      "2026-08-23": 7,
      "2026-08-29": 1,
      "2026-08-30": null,
    });
  });

  it("maps a venue group to its template action and falls back for unknown groups", () => {
    expect(
      runPython(
        "m = load('adminbot-deadline-reminders')\n" +
          "print(json.dumps([m.action_key_for({'venue_group': 'NeurIPS 2026 Workshops'}), " +
          "m.action_key_for({'venue_group': 'Brand New 2027 Workshops'}), " +
          "m.action_key_for({'venue_group': 'Some New Venue'}), m.action_key_for({})]))",
      ),
      // Any "<venue> Workshops" group reaches the one venue-agnostic workshop template, so a new
      // series needs a dataset row rather than a code edit.
    ).toEqual(["workshop", "workshop", "emnlp_commitment", "emnlp_commitment"]);
  });
});
