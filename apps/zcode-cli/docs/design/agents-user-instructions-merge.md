# AGENTS.md User And Workspace Merge

## Goal

ZCode should treat `~/.zcode/AGENTS.md` as the user's default instruction file and merge it with the workspace `AGENTS.md` resolved for the current session.

## Resolution

- Workspace instruction discovery walks from `workingDirectory` upward until the detected project root, or filesystem root when no project root is detected.
- At every directory level the candidates are tried in this order, and the first one that exists stops the search:
  1. `AGENTS.md`
  2. `.zcode/AGENTS.md`
  3. `.agents/AGENTS.md`

  `AGENTS.md` first means a plain `AGENTS.md` at the repository root wins over the same file kept inside the tool directories. At most one workspace instruction file is read per level, so the search never merges two candidates of the same level. When a level holds more than one existing candidate, only the first one is read; the others are "present but ignored" — the settings page lists them explicitly instead of hiding the shadowing.
- The candidate list, the user-level relative path and the byte limit live in `@zcode/shared` (`instruction-files`): `WORKSPACE_INSTRUCTION_FILE_CANDIDATES`, `USER_INSTRUCTION_FILE_RELATIVE_PATH`, `INSTRUCTION_FILE_MAX_BYTES`. The reader (`@zcode/adapters`), the settings page and the host-side instruction file service all consume that single definition.
- The user default instruction file is `~/.zcode/AGENTS.md`.
- `HOME` resolves the user directory first. On Windows-style environments, `USERPROFILE` is used when `HOME` is absent. If neither is set, Node's `homedir()` is used.
- The user default file is only considered when `priorityFiles` includes `AGENTS.md`. Custom priority sets that omit `AGENTS.md` must not load `~/.zcode/AGENTS.md`.
- Reading stops at `INSTRUCTION_FILE_MAX_BYTES` (100 KiB) per file: the bytes beyond the limit are never injected into the prompt, which is why both the reader and the settings page report a `truncated` flag instead of silently dropping content.

## Merge Order

When both sources exist, ZCode injects both in this order:

1. User default instructions from `~/.zcode/AGENTS.md`.
2. Workspace instructions from the resolved workspace `AGENTS.md`.

Workspace instructions appear later so they can narrow or override broad user defaults for work inside the repository.

## Prompt Shape

Each loaded source is rendered as its own labeled block under the request-level `# agentsMd` section:

- `Contents of <path> (user default instructions):`
- `Contents of <path> (workspace instructions):`

The combined block is still request-level meta user context and continues to precede `# currentDate`.
`# agentsMd` names the aggregated request-user-context
field rather than a specific source file. It is rendered exactly once whenever that field contains
at least one non-empty source. A non-empty Project Memory index therefore also renders the title,
even when no AGENTS.md source is loaded.

## Compatibility

`ResolvedUserInstructions` keeps its historical single-source fields for compatibility, while also exposing a `sources` array for multi-source rendering. Existing callers that only inspect `filePath` or `content` continue to receive a deterministic primary path and merged content.
