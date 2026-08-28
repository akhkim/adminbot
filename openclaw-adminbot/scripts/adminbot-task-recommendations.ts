#!/usr/bin/env tsx
// Emits the applicant task-recommendation JSON that the project-matching mail is generated from.
//
//   node --import tsx scripts/adminbot-task-recommendations.ts --catalog
//   node --import tsx scripts/adminbot-task-recommendations.ts --assign assignments.json [--out plan.json]
//
// `--catalog` prints the recommendation catalog: every sentence the lab approved, with its id. Use
// it to pick ids when writing an assignments file.
//
// `--assign` takes the per-applicant mapping and renders the plan. The assignments file is a list,
// because the same applicant must never appear twice:
//
//   [
//     { "name": "...", "email": "...", "recommendation": "adminbot_only",
//       "application_form_link": "https://docs.google.com/forms/d/e/.../viewform?edit2=..." },
//     { "name": "...", "email": "...", "recommendation": "adminbot_and_causaltutor",
//       "values": { "causal_topic": "..." }, "application_form_link": "..." }
//   ]
//
// Why this exists rather than a hand-written JSON: the previous batch was assembled by writing the
// recommendation sentences straight into the plan, and one applicant was sent a recommendation
// naming work they had no connection to. Rendering every sentence from the reviewed catalog means
// a correction to the copy cannot miss a file, and the two failure modes that produced the last
// round of corrections are refusals here rather than mail:
//
//   - an unfilled placeholder in the sentence (it claims to be Zhijing's personal judgement)
//   - the blank application form instead of the applicant's own response
//
// Nothing is sent. This writes a plan; mailing it is a separate, approved step.
import fs from "node:fs";
import { applicantResponseLinkProblem } from "../extensions/adminbot/src/workflows/onboarding/guide.ts";
import {
  ADMINBOT_TASK_RECOMMENDATIONS,
  renderTaskRecommendation,
} from "../extensions/adminbot/src/workflows/onboarding/task-recommendations.ts";

type Assignment = {
  name?: string;
  email?: string;
  recommendation?: string;
  application_form_link?: string;
  values?: Record<string, string>;
};

type PlanEntry = {
  name: string;
  email: string;
  recommendation: string;
  task_recommendation: string;
  application_form_link: string;
};

type Skipped = { name: string; email: string; reason: string };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readAssignments(path: string): Assignment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not read ${path}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    fail(`${path} must contain a JSON array of assignments`);
  }
  return parsed as Assignment[];
}

export function buildPlan(assignments: readonly Assignment[]): {
  generated_at: string;
  entries: PlanEntry[];
  skipped: Skipped[];
} {
  const entries: PlanEntry[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();

  for (const assignment of assignments) {
    const name = assignment.name?.trim() ?? "";
    const email = assignment.email?.trim() ?? "";
    const skip = (reason: string) => skipped.push({ name, email, reason });

    if (!email.includes("@")) {
      skip("no email address on this assignment");
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      skip("this applicant already appears earlier in the assignments file");
      continue;
    }
    seen.add(key);

    const rendered = renderTaskRecommendation(assignment.recommendation ?? "", assignment.values);
    if (!rendered.ok) {
      skip(
        rendered.reason === "unknown-id"
          ? `unknown recommendation id: ${assignment.recommendation ?? "(none)"}`
          : `recommendation needs ${rendered.missing.join(", ")}`,
      );
      continue;
    }

    const link = assignment.application_form_link?.trim() ?? "";
    if (!link) {
      skip("no application_form_link: the project lead needs this applicant's own response");
      continue;
    }
    const problem = applicantResponseLinkProblem(link);
    if (problem) {
      skip(problem);
      continue;
    }

    entries.push({
      name,
      email,
      recommendation: assignment.recommendation ?? "",
      task_recommendation: rendered.text,
      application_form_link: link,
    });
  }
  return { generated_at: new Date().toISOString(), entries, skipped };
}

function main(argv: readonly string[]): void {
  if (argv.includes("--catalog")) {
    console.log(JSON.stringify(ADMINBOT_TASK_RECOMMENDATIONS, undefined, 2));
    return;
  }
  const assignIndex = argv.indexOf("--assign");
  if (assignIndex === -1 || !argv[assignIndex + 1]) {
    fail("usage: --catalog | --assign <assignments.json> [--out <plan.json>]");
  }
  const plan = buildPlan(readAssignments(argv[assignIndex + 1] as string));
  const output = JSON.stringify(plan, undefined, 2);
  const outIndex = argv.indexOf("--out");
  if (outIndex !== -1 && argv[outIndex + 1]) {
    fs.writeFileSync(argv[outIndex + 1] as string, `${output}\n`);
    console.error(`${plan.entries.length} planned, ${plan.skipped.length} skipped`);
    for (const entry of plan.skipped) {
      console.error(`  skipped ${entry.name || entry.email}: ${entry.reason}`);
    }
    return;
  }
  console.log(output);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  main(process.argv.slice(2));
}
