/* eslint-disable max-lines -- Hook 表单集中维护 runner 类型、Scope 与高级兼容字段。 */
import { useCallback, useState, type ReactNode } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import {
  HOOK_EVENT_NAMES,
  HOOK_EVENT_DESCRIPTORS,
  type Hook,
  type HookConfig,
  type HookEvent,
  type HookType,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { PluginScopeMenu, getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

interface HookFormProps {
  hook?: Hook;
  workspaceAvailable?: boolean;
  defaultStorageLevel?: "user" | "project";
  onSave: (config: HookConfig) => void;
  onCancel: () => void;
  onDelete?: (hook: Hook) => void;
  isEditing?: boolean;
  workspaceTabs?: WorkspaceTabState[];
  selectedScopeKey?: string;
  onScopeKeyChange?: (scopeKey: string) => void;
}

const HOOK_EVENTS = HOOK_EVENT_NAMES;

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** 类型下拉 → i18n key 映射（mcp_tool 的 key 是驼峰写法）。 */
const HOOK_TYPE_LABEL_KEYS: Record<HookType, string> = {
  process: "settings.hooks.type.process",
  command: "settings.hooks.type.command",
  http: "settings.hooks.type.http",
  mcp_tool: "settings.hooks.type.mcpTool",
};

function formatCustomJson(custom?: Record<string, unknown>): string {
  return custom && Object.keys(custom).length > 0 ? JSON.stringify(custom, null, 2) : "";
}

/** 把任意 JSON object 值格式化为多行文本；非对象或空对象返回空串。 */
function formatJsonObject(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.keys(value as Record<string, unknown>).length > 0
    ? JSON.stringify(value, null, 2)
    : "";
}

/** 解析 JSON 文本为 object；空文本返回 undefined，非法或非对象时抛错。 */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** 校验 url 必填且协议为 http/https（spec §10.1 协议白名单）。 */
function isValidHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function HookScopeMenu({
  disabled,
  scopeKey,
  workspaceTabs,
  onChange,
}: {
  disabled: boolean;
  scopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  onChange: (scopeKey: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span className="shrink-0 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.scope.label" })}
      </span>
      <PluginScopeMenu
        align="end"
        disabled={disabled}
        selectedScopeKey={scopeKey}
        workspaceTabs={workspaceTabs}
        onScopeKeyChange={onChange}
      />
    </label>
  );
}

export function HookForm({
  hook,
  workspaceAvailable = false,
  defaultStorageLevel = "user",
  onSave,
  onCancel,
  onDelete,
  isEditing = false,
  workspaceTabs = [],
  selectedScopeKey,
  onScopeKeyChange,
}: HookFormProps) {
  const { intl } = useZCodeIntl();
  const initialStorageLevel = hook?.location?.scope === "project" ? "project" : "user";
  const [storageLevel, setStorageLevel] = useState<"user" | "project">(
    workspaceAvailable ? (hook ? initialStorageLevel : defaultStorageLevel) : "user",
  );
  const initialWorkspaceKey = workspaceTabs[0] ? getPluginWorkspaceKey(workspaceTabs[0]) : "user";
  const scopeKey = selectedScopeKey ?? (storageLevel === "project" ? initialWorkspaceKey : "user");
  const [event, setEvent] = useState<HookEvent>(hook?.event ?? "PreToolUse");
  const [type, setType] = useState<HookType>(hook?.type ?? "process");
  const [matcher, setMatcher] = useState(hook?.matcher ?? "");
  const [command, setCommand] = useState(hook?.command ?? "");
  const [args, setArgs] = useState((hook?.args ?? []).join("\n"));
  const [asyncCommand, setAsyncCommand] = useState(hook?.async ?? false);
  const [shell, setShell] = useState(typeof hook?.shell === "string" ? hook.shell : "");
  const [statusMessage, setStatusMessage] = useState(hook?.statusMessage ?? "");
  const [timeout, setTimeout] = useState(String(hook?.timeout ?? 60));
  const [customJson, setCustomJson] = useState(formatCustomJson(hook?.custom));
  const [customError, setCustomError] = useState<string | null>(null);
  // http 专有字段：通过 custom.url / custom.method / custom.headers /
  // custom.allowedEnvVars / custom.body / custom.allowPrivateNetwork 承载
  // （shared Hook/HookConfig 只提供 custom，http 字段不内联到顶层）。
  const [url, setUrl] = useState(typeof hook?.custom?.url === "string" ? hook.custom.url : "");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [method, setMethod] = useState<HttpMethod | "">(() => {
    const initial = hook?.custom?.method;
    return typeof initial === "string" && (HTTP_METHODS as readonly string[]).includes(initial)
      ? (initial as HttpMethod)
      : "";
  });
  const [headersJson, setHeadersJson] = useState(formatJsonObject(hook?.custom?.headers));
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [allowedEnvVarsText, setAllowedEnvVarsText] = useState(
    Array.isArray(hook?.custom?.allowedEnvVars)
      ? (hook.custom.allowedEnvVars as string[]).join("\n")
      : "",
  );
  const [body, setBody] = useState(typeof hook?.custom?.body === "string" ? hook.custom.body : "");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(
    Boolean(hook?.custom?.allowPrivateNetwork),
  );
  // P3 行为开关（spec: core/spec/hook-framework-expansion-plan.md §5.2）：
  // 状态存 custom.once / custom.failClosed，读取时从 custom 还原。
  const [once, setOnce] = useState(Boolean(hook?.custom?.once));
  const [failClosed, setFailClosed] = useState(Boolean(hook?.custom?.failClosed));
  // mcp_tool 专有字段：通过 custom.server / custom.tool / custom.input 承载。
  const [mcpServer, setMcpServer] = useState(
    typeof hook?.custom?.server === "string" ? hook.custom.server : "",
  );
  const [mcpTool, setMcpTool] = useState(
    typeof hook?.custom?.tool === "string" ? hook.custom.tool : "",
  );
  const [mcpInputJson, setMcpInputJson] = useState(formatJsonObject(hook?.custom?.input));
  const [mcpInputError, setMcpInputError] = useState<string | null>(null);
  const customJsonValid = (() => {
    if (!customJson.trim()) return true;
    try {
      const parsed = JSON.parse(customJson) as unknown;
      return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    } catch {
      return false;
    }
  })();
  const headersJsonValid = (() => {
    if (!headersJson.trim()) return true;
    try {
      const parsed = JSON.parse(headersJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      return Object.values(parsed).every((value) => typeof value === "string");
    } catch {
      return false;
    }
  })();
  const mcpInputJsonValid = (() => {
    if (!mcpInputJson.trim()) return true;
    try {
      const parsed = JSON.parse(mcpInputJson) as unknown;
      return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    } catch {
      return false;
    }
  })();
  const canSave = (() => {
    if (!customJsonValid || !headersJsonValid || !mcpInputJsonValid) return false;
    if (type === "http") return isValidHttpUrl(url);
    if (type === "mcp_tool") return Boolean(mcpServer.trim() && mcpTool.trim());
    return Boolean(command.trim());
  })();
  // failClosed 仅在事件可阻断时可用（描述符 blockable:false 时禁用并提示）。
  const eventBlockable = HOOK_EVENT_DESCRIPTORS[event].blockable;

  const handleSave = useCallback(() => {
    let custom: Record<string, unknown> | undefined;
    if (customJson.trim()) {
      try {
        const parsed = JSON.parse(customJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setCustomError(intl.formatMessage({ id: "settings.hooks.customJsonObjectError" }));
          return;
        }
        custom = parsed as Record<string, unknown>;
      } catch {
        setCustomError(intl.formatMessage({ id: "settings.hooks.customJsonParseError" }));
        return;
      }
    }

    // 行为开关是 once / failClosed 的唯一权威来源，覆盖用户在 JSON 文本框里的同名键。
    const customWithBehavior = { ...custom, once, failClosed };

    const baseConfig = {
      event,
      matcher: matcher.trim() || undefined,
      type,
      statusMessage: statusMessage.trim() || undefined,
      timeout: Number.parseInt(timeout, 10) || 60,
      enabled: hook?.enabled ?? true,
      storageLevel,
    };

    if (type === "http") {
      const trimmedUrl = url.trim();
      if (!isValidHttpUrl(trimmedUrl)) {
        setUrlError(intl.formatMessage({ id: "settings.hooks.http.urlInvalid" }));
        return;
      }
      let headers: Record<string, string> | undefined;
      if (headersJson.trim()) {
        try {
          const parsed = JSON.parse(headersJson) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            setHeadersError(intl.formatMessage({ id: "settings.hooks.http.headersObjectError" }));
            return;
          }
          if (Object.values(parsed).some((value) => typeof value !== "string")) {
            setHeadersError(intl.formatMessage({ id: "settings.hooks.http.headersStringError" }));
            return;
          }
          headers = parsed as Record<string, string>;
        } catch {
          setHeadersError(intl.formatMessage({ id: "settings.hooks.http.headersParseError" }));
          return;
        }
      }
      const envVars = allowedEnvVarsText
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
      setCustomError(null);
      setUrlError(null);
      setHeadersError(null);
      onSave({
        ...baseConfig,
        // 兼容 contracts 的读取路径：http 的 url 也暴露为 command。
        command: trimmedUrl,
        custom: {
          ...customWithBehavior,
          url: trimmedUrl,
          ...(method ? { method } : {}),
          ...(headers ? { headers } : {}),
          ...(envVars.length > 0 ? { allowedEnvVars: envVars } : {}),
          ...(body.trim() ? { body: body.trim() } : {}),
          ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
        },
      });
      return;
    }

    if (type === "mcp_tool") {
      const trimmedServer = mcpServer.trim();
      const trimmedTool = mcpTool.trim();
      if (!trimmedServer || !trimmedTool) return;
      let input: Record<string, unknown> | undefined;
      if (mcpInputJson.trim()) {
        try {
          input = parseJsonObject(mcpInputJson);
        } catch {
          setMcpInputError(intl.formatMessage({ id: "settings.hooks.mcpTool.inputParseError" }));
          return;
        }
      }
      setCustomError(null);
      setMcpInputError(null);
      onSave({
        ...baseConfig,
        // 兼容 contracts 的读取路径：mcp_tool 的 tool 也暴露为 command。
        command: trimmedTool,
        custom: {
          ...customWithBehavior,
          server: trimmedServer,
          tool: trimmedTool,
          ...(input ? { input } : {}),
        },
      });
      return;
    }

    // process / command
    if (!command.trim()) return;
    setCustomError(null);
    onSave({
      ...baseConfig,
      command: command.trim(),
      ...(type === "process"
        ? {
            args: args
              .split("\n")
              .map((arg) => arg.trim())
              .filter(Boolean),
          }
        : {
            async: asyncCommand,
            shell: shell.trim() || (hook?.shell === true ? true : undefined),
          }),
      custom: customWithBehavior,
    });
  }, [
    allowPrivateNetwork,
    allowedEnvVarsText,
    args,
    asyncCommand,
    body,
    command,
    customJson,
    event,
    failClosed,
    headersJson,
    hook?.enabled,
    hook?.shell,
    intl,
    matcher,
    mcpInputJson,
    mcpServer,
    mcpTool,
    method,
    once,
    onSave,
    shell,
    statusMessage,
    storageLevel,
    timeout,
    type,
    url,
  ]);

  return (
    <div className="space-y-4" data-testid="hooks-form">
      <div className="space-y-1">
        <h3 className="text-ui-xl font-semibold text-foreground">
          {intl.formatMessage({
            id: isEditing ? "settings.hooks.edit" : "settings.hooks.add",
          })}
        </h3>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.hooks.description" })}
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid w-full min-w-0 gap-3 sm:grid-cols-2 md:w-auto">
            <Field label={intl.formatMessage({ id: "settings.hooks.event" })} htmlFor="hook-event">
              <Select value={event} onValueChange={(value) => setEvent(value as HookEvent)}>
                <SelectTrigger id="hook-event" size="lg" className="w-full md:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_EVENTS.map((hookEvent) => (
                    <SelectItem key={hookEvent} value={hookEvent}>
                      {hookEvent}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={intl.formatMessage({ id: "settings.hooks.type" })} htmlFor="hook-runner">
              <Select value={type} onValueChange={(value) => setType(value as HookType)}>
                <SelectTrigger id="hook-runner" size="lg" className="w-full md:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["process", "command", "http", "mcp_tool"] as const).map((hookType) => (
                    <SelectItem key={hookType} value={hookType}>
                      {intl.formatMessage({
                        id: HOOK_TYPE_LABEL_KEYS[hookType],
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <HookScopeMenu
            disabled={Boolean(hook)}
            scopeKey={scopeKey}
            workspaceTabs={workspaceAvailable ? workspaceTabs : []}
            onChange={(nextScopeKey) => {
              setStorageLevel(nextScopeKey === "user" ? "user" : "project");
              onScopeKeyChange?.(nextScopeKey);
            }}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={intl.formatMessage({ id: "settings.hooks.matcher" })} htmlFor="matcher">
            <Input
              id="matcher"
              size="lg"
              value={matcher}
              onChange={(event) => setMatcher(event.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.hooks.matcherPlaceholder",
              })}
            />
            <p className="text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "settings.hooks.matcherHint" })}
            </p>
          </Field>

          {type === "process" || type === "command" ? (
            <Field label={intl.formatMessage({ id: "settings.hooks.command" })} htmlFor="command">
              <Input
                id="command"
                size="lg"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder={intl.formatMessage({
                  id: "settings.hooks.commandPlaceholder",
                })}
                className="font-mono"
              />
            </Field>
          ) : null}
        </div>

        {type === "process" ? (
          <Field label={intl.formatMessage({ id: "settings.hooks.args" })} htmlFor="args">
            <SettingsFormTextarea
              id="args"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.hooks.argsPlaceholder",
              })}
              rows={4}
              className="resize-y font-mono"
            />
            <p className="text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "settings.hooks.argsHint" })}
            </p>
          </Field>
        ) : type === "command" ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={intl.formatMessage({ id: "settings.hooks.shell" })} htmlFor="hook-shell">
              <Input
                id="hook-shell"
                size="lg"
                value={shell}
                onChange={(event) => setShell(event.target.value)}
                placeholder={intl.formatMessage({
                  id: "settings.hooks.shellPlaceholder",
                })}
                className="font-mono"
              />
            </Field>
            <div className="flex items-end justify-between gap-4 pb-1">
              <Label htmlFor="hook-async-command">
                {intl.formatMessage({ id: "settings.hooks.async" })}
              </Label>
              <Switch
                id="hook-async-command"
                checked={asyncCommand}
                onCheckedChange={setAsyncCommand}
              />
            </div>
          </div>
        ) : type === "http" ? (
          <div className="space-y-3">
            <Field
              label={intl.formatMessage({ id: "settings.hooks.http.url" })}
              htmlFor="hook-http-url"
            >
              <Input
                id="hook-http-url"
                size="lg"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setUrlError(null);
                }}
                placeholder="https://example.com/hook"
                className="font-mono"
              />
              {urlError ? <p className="text-ui-base text-destructive">{urlError}</p> : null}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={intl.formatMessage({ id: "settings.hooks.http.method" })}
                htmlFor="hook-http-method"
              >
                <Select value={method} onValueChange={(value) => setMethod(value as HttpMethod)}>
                  <SelectTrigger id="hook-http-method" size="lg" className="w-full">
                    <SelectValue
                      placeholder={intl.formatMessage({ id: "settings.hooks.http.method" })}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {HTTP_METHODS.map((httpMethod) => (
                      <SelectItem key={httpMethod} value={httpMethod}>
                        {httpMethod}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex items-end justify-between gap-4 pb-1">
                <Label htmlFor="hook-http-private-network">
                  {intl.formatMessage({ id: "settings.hooks.http.allowPrivateNetwork" })}
                </Label>
                <Switch
                  id="hook-http-private-network"
                  checked={allowPrivateNetwork}
                  onCheckedChange={setAllowPrivateNetwork}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={intl.formatMessage({ id: "settings.hooks.http.headers" })}
                htmlFor="hook-http-headers"
              >
                <SettingsFormTextarea
                  id="hook-http-headers"
                  value={headersJson}
                  onChange={(event) => {
                    setHeadersJson(event.target.value);
                    setHeadersError(null);
                  }}
                  rows={4}
                  className="resize-y font-mono"
                  placeholder={'{\n  "Authorization": "Bearer $TOKEN"\n}'}
                />
                {headersError ? (
                  <p className="text-ui-base text-destructive">{headersError}</p>
                ) : null}
              </Field>
              <Field
                label={intl.formatMessage({ id: "settings.hooks.http.allowedEnvVars" })}
                htmlFor="hook-http-env-vars"
              >
                <SettingsFormTextarea
                  id="hook-http-env-vars"
                  value={allowedEnvVarsText}
                  onChange={(event) => setAllowedEnvVarsText(event.target.value)}
                  rows={4}
                  className="resize-y font-mono"
                  placeholder={"TOKEN\nAPI_KEY"}
                />
              </Field>
            </div>
            <Field
              label={intl.formatMessage({ id: "settings.hooks.http.body" })}
              htmlFor="hook-http-body"
            >
              <SettingsFormTextarea
                id="hook-http-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={3}
                className="resize-y font-mono"
              />
            </Field>
          </div>
        ) : (
          <div className="space-y-3">
            <Field
              label={intl.formatMessage({ id: "settings.hooks.mcpTool.server" })}
              htmlFor="hook-mcp-server"
            >
              <Input
                id="hook-mcp-server"
                size="lg"
                value={mcpServer}
                onChange={(event) => setMcpServer(event.target.value)}
                placeholder={intl.formatMessage({ id: "settings.hooks.mcpTool.empty" })}
                className="font-mono"
              />
            </Field>
            <Field
              label={intl.formatMessage({ id: "settings.hooks.mcpTool.tool" })}
              htmlFor="hook-mcp-tool"
            >
              <Input
                id="hook-mcp-tool"
                size="lg"
                value={mcpTool}
                onChange={(event) => setMcpTool(event.target.value)}
                placeholder="e.g. read_file"
                className="font-mono"
              />
            </Field>
            <Field
              label={intl.formatMessage({ id: "settings.hooks.mcpTool.input" })}
              htmlFor="hook-mcp-input"
            >
              <SettingsFormTextarea
                id="hook-mcp-input"
                value={mcpInputJson}
                onChange={(event) => {
                  setMcpInputJson(event.target.value);
                  setMcpInputError(null);
                }}
                rows={4}
                className="resize-y font-mono"
                placeholder={'{\n  "path": "/workspace"\n}'}
              />
              {mcpInputError ? (
                <p className="text-ui-base text-destructive">{mcpInputError}</p>
              ) : null}
            </Field>
          </div>
        )}

        {/* P3 行为开关（spec: core/spec/hook-framework-expansion-plan.md §5.2），对所有 handler 类型生效。 */}
        <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
          <div className="flex items-end justify-between gap-4 pb-1">
            <div className="min-w-0">
              <Label htmlFor="hook-once">{intl.formatMessage({ id: "settings.hooks.once" })}</Label>
              <p className="text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: "settings.hooks.onceHint" })}
              </p>
            </div>
            <Switch id="hook-once" checked={once} onCheckedChange={setOnce} />
          </div>
          <div className="flex items-end justify-between gap-4 pb-1">
            <div className="min-w-0">
              <Label htmlFor="hook-fail-closed">
                {intl.formatMessage({ id: "settings.hooks.failClosed" })}
              </Label>
              <p className="text-ui-base text-foreground-subtlest">
                {eventBlockable
                  ? intl.formatMessage({ id: "settings.hooks.failClosedHint" })
                  : intl.formatMessage({ id: "settings.hooks.failClosedDisabledHint" })}
              </p>
            </div>
            <Switch
              id="hook-fail-closed"
              checked={failClosed}
              disabled={!eventBlockable}
              onCheckedChange={setFailClosed}
            />
          </div>
        </div>

        <details className="group/advanced border-t border-border pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-ui-base font-medium text-foreground-subtle">
            <ChevronRight
              className="size-3.5 transition-transform group-open/advanced:rotate-90"
              aria-hidden="true"
            />
            {intl.formatMessage({ id: "settings.hooks.advanced" })}
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={intl.formatMessage({ id: "settings.hooks.timeout" })} htmlFor="timeout">
                <Input
                  id="timeout"
                  size="lg"
                  type="number"
                  min={1}
                  value={timeout}
                  onChange={(event) => setTimeout(event.target.value)}
                  className="w-28"
                />
                <p className="text-ui-base text-foreground-subtlest">
                  {intl.formatMessage({ id: "settings.hooks.timeoutHint" })}
                </p>
              </Field>

              <Field
                label={intl.formatMessage({
                  id: "settings.hooks.statusMessage",
                })}
                htmlFor="hook-status-message"
              >
                <Input
                  id="hook-status-message"
                  size="lg"
                  value={statusMessage}
                  onChange={(event) => setStatusMessage(event.target.value)}
                  placeholder={intl.formatMessage({
                    id: "settings.hooks.statusMessagePlaceholder",
                  })}
                />
              </Field>
            </div>

            <Field
              label={intl.formatMessage({ id: "settings.hooks.customJson" })}
              htmlFor="hook-custom-json"
            >
              <SettingsFormTextarea
                id="hook-custom-json"
                value={customJson}
                onChange={(event) => setCustomJson(event.target.value)}
                rows={5}
                className="resize-y font-mono text-ui-base"
                placeholder={'{\n  "customKey": "value"\n}'}
              />
              {customError ? <p className="text-ui-base text-destructive">{customError}</p> : null}
            </Field>
          </div>
        </details>

        <SettingsFormActions
          leadingAction={
            hook && onDelete ? (
              <Button
                type="button"
                variant="link"
                size="lg"
                className="px-0 text-destructive hover:text-destructive"
                onClick={() => onDelete(hook)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {intl.formatMessage({ id: "common.delete" })}
              </Button>
            ) : undefined
          }
        >
          <Button size="lg" onClick={handleSave} disabled={!canSave}>
            {intl.formatMessage({ id: "common.save" })}
          </Button>
          <Button variant="ghost" size="lg" onClick={onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </SettingsFormActions>
      </div>
    </div>
  );
}

function Field({
  children,
  htmlFor,
  label,
}: {
  children: ReactNode;
  htmlFor?: string;
  label: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-foreground-subtle">
        {label}
      </Label>
      {children}
    </div>
  );
}
