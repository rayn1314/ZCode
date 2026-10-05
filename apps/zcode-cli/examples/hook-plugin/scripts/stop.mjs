#!/usr/bin/env node
// Example Stop hook: request one more model step before finalizing.
console.log(
  JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: "Before finalizing, verify that the answer mentions test coverage.",
    },
  }),
);