export const genUiModule = {
  id: "gen-ui",
  requires: [
    "gen-ui-protocol",
    "gen-ui-service",
    "mcp-apps-protocol",
    "plugin-ui",
    "services",
    "shared",
    "ui",
  ],
  provides: ["gen-ui-message"],
  publicEntrypoints: ["index.ts", "contract.ts", "host.ts"],
} as const;
