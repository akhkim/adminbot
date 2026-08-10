// Formats subagent command help text and usage summaries.
import type { CommandHandlerResult } from "../commands/commands-types.js";
import { buildSubagentsHelp, stopWithText } from "./shared.js";

export function handleSubagentsHelpAction(): CommandHandlerResult {
  return stopWithText(buildSubagentsHelp());
}
