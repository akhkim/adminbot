import { pathToFileURL } from "node:url";
import { runLegacyIdentityMigration } from "./run.js";

interface CliOptions {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly backupDirectory: string;
  readonly organizationId: string;
  readonly apply: boolean;
  readonly invalidateLegacySessions: boolean;
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseArguments(args);
  const result = await runLegacyIdentityMigration(options);
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome === "invalid") process.exitCode = 2;
}

function parseArguments(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let apply = false;
  let invalidateLegacySessions = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--invalidate-legacy-sessions") {
      invalidateLegacySessions = true;
      continue;
    }
    if (argument === undefined || !argument.startsWith("--")) {
      throw new Error("migration arguments must use named flags");
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }
  return {
    sourcePath: required(values, "--source"),
    destinationPath: required(values, "--destination"),
    backupDirectory: required(values, "--backup-directory"),
    organizationId: required(values, "--organization-id"),
    apply,
    invalidateLegacySessions,
  };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new Error(`${flag} is required`);
  return value;
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(JSON.stringify({ outcome: "failed", errorType }));
    process.exitCode = 1;
  });
}
