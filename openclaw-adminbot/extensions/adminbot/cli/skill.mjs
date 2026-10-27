// `adminbot skill install`: copies the agent skill shipped in skill/ into Claude Code's and Codex's
// skill folders, so an admin's agent knows the pages, the rules for changes and the workflow facts.
// It copies rather than links, so reinstalling the CLI somewhere else never leaves a dead link, and
// it replaces only an earlier copy of this skill.
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiError } from "./client.mjs";

const NAME = "adminbot-cli";
const FILES = ["SKILL.md", "pages.md"];
const AGENT_HOMES = [".claude", ".codex"];

export async function installSkill(env = process.env) {
  const home = env.HOME ?? homedir();
  const targets = [];
  for (const agent of AGENT_HOMES) {
    if (!(await lstat(join(home, agent)).catch(() => undefined))) {
      continue;
    }
    const dir = join(home, agent, "skills", NAME);
    const existing = await lstat(dir).catch(() => undefined);
    if (existing && !existing.isSymbolicLink()) {
      const current = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => "");
      if (!new RegExp(`^name: ${NAME}$`, "mu").test(current)) {
        throw new ApiError(
          "SKILL_CONFLICT",
          `${dir} holds a different skill (its SKILL.md is not name: ${NAME}); nothing was changed. Move or rename that folder, then install again`,
          undefined,
          { details: { path: dir } },
        );
      }
    }
    targets.push({ dir, link: existing?.isSymbolicLink() });
  }
  if (!targets.length) {
    throw new ApiError(
      "NO_AGENT",
      "Neither ~/.claude nor ~/.codex exists; install Claude Code or Codex first",
    );
  }
  for (const { dir, link } of targets) {
    if (link) {
      await rm(dir);
    }
    await mkdir(dir, { recursive: true });
    for (const file of FILES) {
      await writeFile(join(dir, file), await readFile(new URL(`./skill/${file}`, import.meta.url)));
    }
  }
  return { installed: targets.map(({ dir }) => dir) };
}
