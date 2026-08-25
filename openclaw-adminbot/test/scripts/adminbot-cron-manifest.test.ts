// The cron manifest is the answer to "what does AdminBot run, and when". These are the ways it
// could silently stop being that: a job naming a wrapper that does not exist, two jobs on the same
// minute against the same service, or a wrapper nothing schedules.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "config/adminbot-cron.json"), "utf8"),
) as { jobs: Array<{ name: string; description: string; cron: string; argv: string[] }> };

const CRON_FIELD_COUNT = 5;

describe("config/adminbot-cron.json", () => {
  it("names a wrapper that exists for every job", () => {
    for (const job of manifest.jobs) {
      const script = job.argv.find((part) => part.startsWith("scripts/"));
      expect(script, `${job.name} runs no script`).toBeDefined();
      expect(
        fs.existsSync(path.join(repoRoot, script as string)),
        `${job.name} names a missing wrapper: ${script}`,
      ).toBe(true);
    }
  });

  it("schedules every cron wrapper in the repo", () => {
    // A wrapper nothing schedules is a feature nobody runs, and it fails silently: no nudge goes
    // out and nothing errors. The two that take a task argument are listed by the tasks used.
    const scheduled = new Set(
      manifest.jobs.flatMap((job) => job.argv.filter((part) => part.startsWith("scripts/"))),
    );
    const wrappers = fs
      .readdirSync(path.join(repoRoot, "scripts"))
      .filter((name) => name.startsWith("adminbot-") && name.endsWith("-cron.sh"))
      .map((name) => `scripts/${name}`);
    expect([...wrappers].filter((wrapper) => !scheduled.has(wrapper))).toEqual([]);
  });

  it("gives every job a name, a description and a five-field schedule", () => {
    for (const job of manifest.jobs) {
      expect(job.name).toMatch(/^adminbot-[a-z0-9-]+$/u);
      expect(job.description.trim().length).toBeGreaterThan(0);
      expect(job.cron.trim().split(/\s+/u)).toHaveLength(CRON_FIELD_COUNT);
    }
  });

  it("uses each name once, so a sync cannot register a job twice", () => {
    const names = manifest.jobs.map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("staggers the passes rather than piling them onto one minute", () => {
    // They all hit the same service on the same box; a simultaneous start makes one slow pass look
    // like an outage. Hourly jobs are exempt -- their minute is the whole schedule.
    const daily = manifest.jobs.filter((job) => !job.cron.startsWith("5 *"));
    const slots = daily.map((job) => job.cron.split(/\s+/u).slice(0, 2).join(":"));
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("escalates after the nudges it is meant to be chasing", () => {
    const hourOf = (name: string) => {
      const job = manifest.jobs.find((entry) => entry.name === name);
      return Number(job?.cron.split(/\s+/u)[1]);
    };
    // Escalation reads what the morning passes filed. Running it first would chase yesterday's
    // list and miss everything today's nudges just added.
    expect(hourOf("adminbot-nudge-escalation")).toBeGreaterThan(
      hourOf("adminbot-mandatory-fields"),
    );
    expect(hourOf("adminbot-nudge-escalation")).toBeGreaterThan(
      hourOf("adminbot-paper-slot-nudges"),
    );
  });
});
