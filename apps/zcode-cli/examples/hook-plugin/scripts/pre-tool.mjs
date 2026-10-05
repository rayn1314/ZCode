#!/usr/bin/env node
// Example PreToolUse hook: block destructive commands on matched tools.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const toolName = input.tool_name ?? "";
const danger = /rm -rf|format|drop/.test(JSON.stringify(input.tool_input ?? {}));
if (danger) {
  console.log(
    JSON.stringify({
      continue: false,
      reason: "Destructive command blocked by example plugin.",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Blocked by example plugin.",
      },
    }),
  );
  process.exit(0);
}
// Allow: return nothing (empty stdout) for non-dangerous invocations.