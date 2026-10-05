#!/usr/bin/env node
// Example SessionStart hook: inject repository-specific guidance.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Session ${input.session_id} started. Prefer the internal API checklist in docs/.`,
    },
  }),
);