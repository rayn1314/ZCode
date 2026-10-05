#!/usr/bin/env node
// Example PostToolUse hook: rewrite the tool result returned to the model.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const response = input.tool_response;
const rewritten = `[example-plugin] tool ${input.tool_name} completed.\n${
  typeof response === "string" ? response : JSON.stringify(response)
}`;
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: rewritten,
    },
  }),
);