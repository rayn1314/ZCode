# Hook Example Plugin

This directory is a minimal local plugin demonstrating the ZCode hook framework. It shows:

- Multiple events (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `PermissionDenied`, `Notification`).
- Regex `matcher` groups for tool-based events.
- The three handler kinds: `process`, `http`, and `mcp_tool`.
- P3 behavior fields: `once` (run once per session) and `failClosed` (block the action when the hook fails).
- P3 protocol features: `updatedToolOutput` rewrites the tool result seen by the model.

## Layout

```txt
hook-plugin/
  .zcode-plugin/plugin.json   # plugin manifest
  hooks/hooks.json            # hook declarations (standard path: hooks/hooks.json)
  scripts/                    # example process hook scripts
    session-start.mjs
    pre-tool.mjs
    post-tool.mjs
    stop.mjs
```

## Install

Add the plugin directory to `plugins.dirs` in `~/.zcode/cli/config.json`:

```json
{
  "plugins": {
    "dirs": ["/absolute/path/to/apps/zcode-cli/examples/hook-plugin"]
  }
}
```

Then run `zcode plugins list` and `zcode plugins enable hook-example`, or start a session in a
workspace that has the plugin directory configured.

## Notes

- `process` hook `command` values are executed as-is; no variable expansion is applied to plugin
  hook commands. The example uses `node ./scripts/<name>.mjs`, which works when the CLI process runs
  from the plugin root. For production plugins, point `args` at an absolute path or a path resolved
  by the plugin installer.
- The `http` hook (`PermissionDenied`) posts to `http://localhost:8080/hooks/permission-denied`.
  Localhost and link-local addresses are always rejected by the SSRF guard; private networks require
  `allowPrivateNetwork: true` (see the hook framework spec).
- The `mcp_tool` hook (`Notification`) calls tool `notify` on MCP server `my-mcp`. Configure that
  server in the plugin manifest or the workspace `.mcp.json` before enabling the hook.
- Hook scripts print one JSON object to stdout. Empty stdout means no-op; exit code `2` is an
  explicit block/deny. Non-zero exits other than `2` are recorded as failures and, by default, do
  not crash the turn (`failClosed: true` changes that for blockable events).