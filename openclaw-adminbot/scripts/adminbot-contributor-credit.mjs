// Generate reviewed contributor credit from merged AdminBot PRs; never edit Overleaf remotely.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isMainModule } from "./lib/is-main-module.mjs";

export function contributorCredit(prs, people) {
  const merged = new Map(prs.filter((pr) => pr.mergedAt).map((pr) => [pr.number, pr]));
  const logins = new Set();
  return people
    .map((person) => {
      if (!person.name?.trim() || !person.login || logins.has(person.login.toLowerCase())) {
        throw new Error("Each contributor needs a unique login and verified display name");
      }
      logins.add(person.login.toLowerCase());
      const features = new Set();
      for (const feature of person.features) {
        if (!feature.id?.trim() || !feature.prs?.length) {
          throw new Error("Each reviewed feature needs a stable ID and supporting PRs");
        }
        for (const number of feature.prs) {
          const pr = merged.get(number);
          if (!pr || pr.author?.login?.toLowerCase() !== person.login.toLowerCase()) {
            throw new Error(`PR #${number} is not a merged contribution by ${person.login}`);
          }
        }
        features.add(feature.id);
      }
      return {
        login: person.login,
        name: person.name.trim(),
        features: features.size,
        prs: [...new Set(person.features.flatMap((feature) => feature.prs))],
      };
    })
    .filter((person) => person.features >= 3)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

export function bibAuthor(names) {
  const escape = (name) =>
    name.replace(
      /[\\{}%&_$#~^]/g,
      (char) =>
        ({
          "\\": "\\textbackslash{}",
          "~": "\\textasciitilde{}",
          "^": "\\textasciicircum{}",
        })[char] ?? `\\${char}`,
    );
  return `author = {${names.map(escape).join(" and ")}},`;
}

if (isMainModule(import.meta.url)) {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node scripts/adminbot-contributor-credit.mjs reviewed-features.json");
  }
  const people = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const prs = JSON.parse(
    execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        "akhkim/adminbot",
        "--state",
        "merged",
        "--limit",
        "10000",
        "--json",
        "number,title,author,mergedAt,url",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  if (prs.length === 10000) throw new Error("PR history limit reached; refuse incomplete credit");
  const contributors = contributorCredit(prs, people);
  console.log(
    JSON.stringify(
      { contributors, authorField: bibAuthor(contributors.map((p) => p.name)) },
      null,
      2,
    ),
  );
}
