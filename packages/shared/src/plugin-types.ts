export interface PluginMarketplaceSummary {
  id: string;
  name: string;
  source: string;
  installLocation?: string;
  lastUpdated?: string;
  pluginCount: number;
  description?: string;
  isOfficial: boolean;
}

export type PluginComponentType = "agent" | "command" | "skill" | "hook" | "mcp" | "lsp";

export type PluginScope = "workspace" | "user";

export interface PluginHookDetail {
  args?: string[];
  async?: boolean;
  command: string;
  event: string;
  matcher?: string;
  runnable: boolean;
  shell?: true | string;
  sourcePath: string;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command" | "process" | "http" | "mcp_tool";
  // http / mcp_tool handler 的专有字段（spec: core/spec/hook-framework-expansion.md §10）。
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  body?: string;
  allowPrivateNetwork?: boolean;
  server?: string;
  tool?: string;
  input?: Record<string, unknown>;
}

export interface AvailablePluginSummary {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  componentTypes?: PluginComponentType[];
}

export interface InstalledPluginSummary {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  enabled: boolean;
  scope: PluginScope;
  installPath?: string;
  nativeScope?: "user" | "project" | "local";
  projectPath?: string;
  installedAt?: string;
  componentTypes?: PluginComponentType[];
  hookDetails?: PluginHookDetail[];
}

export interface PluginsCapability {
  supported: boolean;
  reason?: "desktop_only" | "missing_cli";
}

export interface PluginsOverviewResult {
  marketplaces: PluginMarketplaceSummary[];
  availablePlugins: AvailablePluginSummary[];
  installedPlugins: InstalledPluginSummary[];
  capability: PluginsCapability;
}
