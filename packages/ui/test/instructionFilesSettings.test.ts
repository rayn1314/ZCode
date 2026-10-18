// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InstructionFileSnapshot,
  InstructionFileWriteResult,
} from "@/settings/instructionFiles.js";

const h = vi.hoisted(() => {
  const state = {
    user: null as InstructionFileSnapshot | null,
    workspace: null as InstructionFileSnapshot | null,
    readError: null as Error | null,
    writeResult: { ok: true } as InstructionFileWriteResult,
    writeError: null as Error | null,
  };
  const readInstructionFile = vi.fn(async (input: { scope: string }) => {
    if (state.readError) throw state.readError;
    return input.scope === "user" ? state.user : state.workspace;
  });
  const writeInstructionFile = vi.fn(async () => {
    if (state.writeError) throw state.writeError;
    return state.writeResult;
  });
  const toast = vi.fn();
  const resolution = {
    remoteSessionId: null as string | null,
    isRemoteTarget: false,
    connectionKind: "local-ready" as const,
    rpcReady: true,
    services: {} as unknown,
  };
  resolution.services = { instructionsService: { readInstructionFile, writeInstructionFile } };
  return { state, readInstructionFile, writeInstructionFile, toast, resolution };
});

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => h.resolution,
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: h.toast }));
vi.mock("@/i18n/IntlProvider.js", async () => {
  const { default: enUS } = await import("@/i18n/locales/en-US.js");
  // 与真实 provider 一致：intl 身份稳定（真实实现用 useMemo 缓存），否则每次 render 都是新对象。
  const intl = {
    formatMessage: (descriptor: { id: string }, values?: Record<string, unknown>): string => {
      const template = enUS[descriptor.id] ?? descriptor.id;
      if (!values) return template;
      return template.replace(/\{(\w+)\}/gu, (_match, key: string) =>
        key in values ? String(values[key]) : `{${key}}`,
      );
    },
  };
  return { useZCodeIntl: () => ({ locale: "en-US", intl }) };
});
vi.mock("@/WorkspaceEditorButtonGroup.js", () => ({
  WorkspaceEditorButtonGroup: () =>
    createElement("div", { "data-testid": "workspace-editor-button-group" }),
}));

import enUS from "@/i18n/locales/en-US.js";
import { InstructionFilesSection } from "@/settings/InstructionFilesSection.js";
import {
  formatInstructionBytes,
  formatInstructionMtime,
  INSTRUCTION_FILE_MAX_BYTES,
  resolveInstructionsService,
} from "@/settings/instructionFiles.js";

function msg(id: string): string {
  return enUS[id] ?? id;
}

const USER_PATH = "/home/user/.zcode/AGENTS.md";
const REPO_ROOT_PATH = "/repo/AGENTS.md";
const REPO_ZCODE_PATH = "/repo/.zcode/AGENTS.md";
const USER_MTIME = Date.UTC(2026, 9, 18, 6, 3);

function cardSnapshot(overrides: Partial<InstructionFileSnapshot> = {}): InstructionFileSnapshot {
  return {
    scope: "user",
    targetPath: USER_PATH,
    effectivePath: USER_PATH,
    ignoredCandidates: [],
    exists: true,
    bytes: 820,
    mtimeMs: USER_MTIME,
    truncated: false,
    content: "user instructions",
    writable: true,
    ...overrides,
  };
}

function renderSection(overrides: Record<string, unknown> = {}) {
  return render(
    createElement(InstructionFilesSection, {
      workspacePath: "/repo",
      fileManagementAvailable: true,
      ...overrides,
    }),
  );
}

/** 读取完成后主按钮才可用：先等读取结果渲染出来，避免点到加载态里的禁用按钮。 */
async function openEditor(scope: "user" | "workspace" = "user"): Promise<HTMLTextAreaElement> {
  await screen.findByTestId(`instructions-${scope}-effective-path`);
  fireEvent.click(screen.getByTestId(`instructions-${scope}-edit`));
  return screen.getByTestId(`instructions-${scope}-editor`) as HTMLTextAreaElement;
}

function editorValue(scope: "user" | "workspace"): string {
  return (screen.getByTestId(`instructions-${scope}-editor`) as HTMLTextAreaElement).value;
}

function isDisabled(testId: string): boolean {
  return (screen.getByTestId(testId) as HTMLButtonElement).disabled;
}

function userReadCount(): number {
  return h.readInstructionFile.mock.calls.filter((call) => call[0].scope === "user").length;
}

async function saveAndAwaitConflict(scope: "user" | "workspace" = "user"): Promise<void> {
  h.state.writeResult = { ok: false, reason: "conflict" };
  fireEvent.click(screen.getByTestId(`instructions-${scope}-save`));
  await screen.findByTestId("instructions-conflict-dialog");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.user = cardSnapshot();
  h.state.workspace = cardSnapshot({
    scope: "workspace",
    targetPath: REPO_ROOT_PATH,
    effectivePath: REPO_ROOT_PATH,
    content: "repo instructions",
  });
  h.state.readError = null;
  h.state.writeError = null;
  h.state.writeResult = { ok: true };
  h.resolution.isRemoteTarget = false;
  h.resolution.rpcReady = true;
  h.resolution.services = {
    instructionsService: {
      readInstructionFile: h.readInstructionFile,
      writeInstructionFile: h.writeInstructionFile,
    },
  };
});

afterEach(() => {
  cleanup();
});

describe("指令文件设置页边界", () => {
  it("Web Remote / 手机只显示桌面端提示且零服务调用", () => {
    renderSection({ fileManagementAvailable: false });

    expect(screen.getByText(msg("settings.instructions.desktopOnly"))).toBeTruthy();
    expect(screen.queryByTestId("instructions-settings-section")).toBeNull();
    expect(h.readInstructionFile).not.toHaveBeenCalled();
  });

  it("没有打开工作区时给出空态且零服务调用", () => {
    renderSection({ workspacePath: null });

    expect(screen.getByText(msg("settings.instructions.noWorkspace"))).toBeTruthy();
    expect(h.readInstructionFile).not.toHaveBeenCalled();
  });

  it("服务未注入时按加载失败态渲染，不伪造未创建", async () => {
    h.resolution.services = {};

    renderSection();

    expect(
      await screen.findAllByText(msg("settings.instructions.serviceUnavailable")),
    ).toHaveLength(2);
    expect(screen.queryByText(msg("settings.instructions.notCreated"))).toBeNull();
  });

  it("连接未就绪时展示骨架并禁用操作", async () => {
    h.resolution.rpcReady = false;

    renderSection();

    expect(await screen.findByTestId("instructions-user-loading")).toBeTruthy();
    expect(await screen.findByTestId("instructions-workspace-loading")).toBeTruthy();
    expect(isDisabled("instructions-user-edit")).toBe(true);
    expect(isDisabled("instructions-workspace-edit")).toBe(true);
    expect(h.readInstructionFile).not.toHaveBeenCalled();
  });
});

describe("指令文件设置页两级卡片", () => {
  it("按生效顺序展示用户级与仓库级，并显示实际读取路径与状态行", async () => {
    renderSection();

    expect(await screen.findByTestId("instructions-user-effective-path")).toBeTruthy();
    expect(screen.getByTestId("instructions-user-effective-path").textContent).toBe(USER_PATH);
    expect(screen.getByTestId("instructions-workspace-effective-path").textContent).toBe(
      REPO_ROOT_PATH,
    );
    expect(screen.getByTestId("instructions-user-bytes").textContent).toBe("820 B");

    // 顺序即生效顺序：用户级在前，仓库级在后。
    const userSection = screen.getByTestId("instructions-user-section");
    const workspaceSection = screen.getByTestId("instructions-workspace-section");
    expect(userSection.compareDocumentPosition(workspaceSection)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("仓库根 AGENTS.md 与 .zcode/AGENTS.md 同时存在时只读根、另一个标为被忽略", async () => {
    h.state.workspace = cardSnapshot({
      scope: "workspace",
      targetPath: REPO_ROOT_PATH,
      effectivePath: REPO_ROOT_PATH,
      ignoredCandidates: [REPO_ZCODE_PATH],
      content: "root instructions",
    });

    renderSection();

    expect(
      (await screen.findAllByTestId("instructions-workspace-ignored-candidate"))[0].textContent,
    ).toBe(`Ignored: ${REPO_ZCODE_PATH} (exists but not read)`);
    expect(screen.getByTestId("instructions-workspace-effective-path").textContent).toBe(
      REPO_ROOT_PATH,
    );
  });

  it("只有 .zcode/AGENTS.md 存在时它成为实际读取路径且没有被忽略项", async () => {
    h.state.workspace = cardSnapshot({
      scope: "workspace",
      targetPath: REPO_ZCODE_PATH,
      effectivePath: REPO_ZCODE_PATH,
      ignoredCandidates: [],
    });

    renderSection();

    expect((await screen.findByTestId("instructions-workspace-effective-path")).textContent).toBe(
      REPO_ZCODE_PATH,
    );
    expect(screen.queryAllByTestId("instructions-workspace-ignored-candidate")).toHaveLength(0);
  });

  it("两级都无时显示未创建，主按钮为用模板新建且模板只给骨架", async () => {
    const missing = { exists: false, bytes: 0, mtimeMs: null, content: "" } as const;
    h.state.user = cardSnapshot({ ...missing });
    h.state.workspace = cardSnapshot({
      ...missing,
      scope: "workspace",
      targetPath: REPO_ROOT_PATH,
      effectivePath: REPO_ROOT_PATH,
    });

    renderSection();

    expect((await screen.findByTestId("instructions-user-effective-path")).textContent).toBe(
      msg("settings.instructions.notCreated"),
    );
    expect(screen.getByTestId("instructions-user-edit").textContent).toContain(
      msg("settings.instructions.create"),
    );

    fireEvent.click(screen.getByTestId("instructions-user-edit"));
    expect(editorValue("user")).toBe(
      `# ${msg("settings.instructions.template.overview")}\n\n## ${msg("settings.instructions.template.commands")}\n\n## ${msg("settings.instructions.template.conventions")}\n\n## ${msg("settings.instructions.template.acceptance")}\n`,
    );
    expect(isDisabled("instructions-user-save")).toBe(false);

    fireEvent.click(screen.getByTestId("instructions-user-save"));
    await waitFor(() => expect(h.writeInstructionFile).toHaveBeenCalledTimes(1));
    expect(h.writeInstructionFile.mock.calls[0][0]).toMatchObject({
      scope: "user",
      expectedMtimeMs: null,
    });
  });

  it("用户级超出 100KB 时显示红色徽标，同时仍可继续编辑", async () => {
    h.state.user = cardSnapshot({ bytes: 120 * 1024, truncated: true });

    renderSection();

    expect((await screen.findByTestId("instructions-user-truncated")).textContent).toBe(
      "Over 100 KB; the agent reads only the first 100 KB",
    );
    expect(screen.getByTestId("instructions-user-bytes").textContent).toBe("120 KB");
    expect(screen.queryByTestId("instructions-workspace-truncated")).toBeNull();

    const editor = await openEditor();
    expect(editor.readOnly).toBe(false);
    fireEvent.change(editor, { target: { value: "edited" } });
    expect(isDisabled("instructions-user-save")).toBe(false);
  });

  it("只读文件强制编辑器只读、禁用保存并展示 readonlyReason", async () => {
    h.state.user = cardSnapshot({ writable: false, readonlyReason: "Permission denied" });

    renderSection();

    expect((await screen.findByTestId("instructions-user-readonly")).textContent).toContain(
      "Permission denied",
    );
    const editor = await openEditor();
    expect(editor.readOnly).toBe(true);

    fireEvent.change(editor, { target: { value: "try to write" } });
    expect(isDisabled("instructions-user-save")).toBe(true);
    expect(h.writeInstructionFile).not.toHaveBeenCalled();
  });

  it("内容未变化时保存禁用", async () => {
    renderSection();

    await openEditor();
    expect(isDisabled("instructions-user-save")).toBe(true);

    fireEvent.change(screen.getByTestId("instructions-user-editor"), {
      target: { value: "user instructions changed" },
    });
    expect(isDisabled("instructions-user-save")).toBe(false);
  });

  it("取消编辑丢弃草稿并关闭编辑器", async () => {
    renderSection();

    await openEditor();
    fireEvent.change(screen.getByTestId("instructions-user-editor"), {
      target: { value: "discarded" },
    });
    fireEvent.click(screen.getByTestId("instructions-user-cancel"));

    expect(screen.queryByTestId("instructions-user-editor")).toBeNull();
    expect(h.writeInstructionFile).not.toHaveBeenCalled();
  });
});

describe("指令文件设置页保存语义", () => {
  it("保存成功写入草稿并沿用磁盘 mtime 作为并发基线", async () => {
    renderSection();

    await openEditor();
    fireEvent.change(screen.getByTestId("instructions-user-editor"), {
      target: { value: "saved content" },
    });
    fireEvent.click(screen.getByTestId("instructions-user-save"));

    await waitFor(() => expect(h.writeInstructionFile).toHaveBeenCalledTimes(1));
    expect(h.writeInstructionFile.mock.calls[0][0]).toMatchObject({
      workspacePath: "/repo",
      scope: "user",
      content: "saved content",
      expectedMtimeMs: USER_MTIME,
    });
    expect(h.toast).toHaveBeenCalledWith(msg("settings.instructions.saved"));
  });

  it("保存失败保留草稿并给出卡片内可操作错误行", async () => {
    h.state.writeResult = { ok: false, reason: "failed", message: "disk full" };

    renderSection();

    await openEditor();
    fireEvent.change(screen.getByTestId("instructions-user-editor"), {
      target: { value: "unsaved content" },
    });
    fireEvent.click(screen.getByTestId("instructions-user-save"));

    const errorRow = await screen.findByTestId("instructions-user-save-error");
    expect(errorRow.textContent).toContain("disk full");
    expect(editorValue("user")).toBe("unsaved content");
    expect(h.toast).toHaveBeenCalledWith(msg("settings.instructions.saveFailed"));
    expect(
      within(errorRow).getByRole("button", { name: msg("settings.instructions.reload") }),
    ).toBeTruthy();
  });

  it("not-writable 保存失败给出权限提示且草稿保留", async () => {
    h.state.writeResult = { ok: false, reason: "not-writable" };

    renderSection();

    await openEditor();
    fireEvent.change(screen.getByTestId("instructions-user-editor"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByTestId("instructions-user-save"));

    expect((await screen.findByTestId("instructions-user-save-error")).textContent).toContain(
      msg("settings.instructions.notWritable"),
    );
    expect(editorValue("user")).toBe("nope");
  });

  it("外部改动导致保存冲突时弹出三选一对话框，取消保留草稿", async () => {
    renderSection();

    await openEditor();
    fireEvent.change(screen.getByTestId("instructions-user-editor"), {
      target: { value: "my local edit" },
    });
    await saveAndAwaitConflict();

    for (const id of [
      "settings.instructions.conflict.overwrite",
      "settings.instructions.conflict.discard",
      "settings.instructions.conflict.cancel",
    ]) {
      expect(screen.getByRole("button", { name: msg(id) })).toBeTruthy();
    }

    fireEvent.click(
      screen.getByRole("button", { name: msg("settings.instructions.conflict.cancel") }),
    );
    await waitFor(() => expect(screen.queryByTestId("instructions-conflict-dialog")).toBeNull());
    expect(editorValue("user")).toBe("my local edit");
  });

  it("冲突时选择放弃修改并重新加载会用磁盘内容替换草稿", async () => {
    renderSection();

    await openEditor();
    fireEvent.change(screen.getByTestId("instructions-user-editor"), {
      target: { value: "my local edit" },
    });
    await saveAndAwaitConflict();

    h.state.user = cardSnapshot({ content: "disk version", bytes: 12 });
    fireEvent.click(
      screen.getByRole("button", { name: msg("settings.instructions.conflict.discard") }),
    );

    await waitFor(() => expect(editorValue("user")).toBe("disk version"));
    expect(h.writeInstructionFile).toHaveBeenCalledTimes(1);
  });

  it("冲突时选择覆盖磁盘内容会用最新磁盘 mtime 重新提交", async () => {
    renderSection();

    await openEditor();
    fireEvent.change(screen.getByTestId("instructions-user-editor"), {
      target: { value: "my local edit" },
    });
    await saveAndAwaitConflict();

    h.state.user = cardSnapshot({ content: "disk version", mtimeMs: 999_000 });
    h.state.writeResult = { ok: true };
    fireEvent.click(
      screen.getByRole("button", { name: msg("settings.instructions.conflict.overwrite") }),
    );

    await waitFor(() => expect(h.writeInstructionFile).toHaveBeenCalledTimes(2));
    expect(h.writeInstructionFile.mock.calls[0][0]).toMatchObject({
      content: "my local edit",
      expectedMtimeMs: USER_MTIME,
    });
    expect(h.writeInstructionFile.mock.calls[1][0]).toMatchObject({
      content: "my local edit",
      expectedMtimeMs: 999_000,
    });
  });
  it("切换工作区后丢弃上一张卡的保存结果，不回写草稿也不刷新新卡", async () => {
    let resolveWrite: ((value: InstructionFileWriteResult) => void) | undefined;
    h.writeInstructionFile.mockImplementationOnce(
      () =>
        new Promise<InstructionFileWriteResult>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    const { rerender } = renderSection();
    await openEditor();
    fireEvent.change(screen.getByTestId("instructions-user-editor"), {
      target: { value: "stale edit" },
    });
    fireEvent.click(screen.getByTestId("instructions-user-save"));
    await waitFor(() => expect(h.writeInstructionFile).toHaveBeenCalledTimes(1));

    h.state.user = cardSnapshot({ content: "other workspace content" });
    rerender(
      createElement(InstructionFilesSection, {
        workspacePath: "/repo2",
        fileManagementAvailable: true,
      }),
    );
    await screen.findByTestId("instructions-user-effective-path");
    const readsAfterSwitch = userReadCount();

    // 在 act 内把微任务排空，确保上一张卡的写入续体已经跑完，再做「没有副作用」断言。
    await act(async () => {
      resolveWrite?.({ ok: false, reason: "failed", message: "stale failure" });
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
    });

    expect(screen.queryByTestId("instructions-user-save-error")).toBeNull();
    expect(screen.queryByText("stale failure")).toBeNull();
    expect(h.toast).not.toHaveBeenCalled();
    expect(userReadCount()).toBe(readsAfterSwitch);
    expect(screen.queryByTestId("instructions-user-editor")).toBeNull();
  });
});

describe("指令文件设置页工作区形态", () => {
  it("本地工作区渲染用外部编辑器打开的入口", async () => {
    renderSection();

    await screen.findByTestId("instructions-user-effective-path");
    expect(screen.getAllByTestId("workspace-editor-button-group")).toHaveLength(2);
  });

  it("远端工作区隐藏外部编辑器入口，并在用户级卡加边注", async () => {
    h.resolution.isRemoteTarget = true;

    renderSection();

    await screen.findByTestId("instructions-user-effective-path");
    expect(screen.getByText(msg("settings.instructions.remoteWorkspaceNote"))).toBeTruthy();
    expect(screen.queryByTestId("workspace-editor-button-group")).toBeNull();
  });

  it("仓库级未创建时该卡不渲染外部编辑器入口", async () => {
    h.state.workspace = cardSnapshot({
      scope: "workspace",
      targetPath: REPO_ROOT_PATH,
      effectivePath: null,
      exists: false,
      bytes: 0,
      mtimeMs: null,
      content: "",
    });

    renderSection();

    await screen.findByTestId("instructions-workspace-effective-path");
    expect(screen.getAllByTestId("workspace-editor-button-group")).toHaveLength(1);
  });
});

describe("指令文件纯逻辑", () => {
  it("按 1024 进制格式化字节数", () => {
    expect(formatInstructionBytes(0)).toBe("0 B");
    expect(formatInstructionBytes(820)).toBe("820 B");
    expect(formatInstructionBytes(2048)).toBe("2.0 KB");
    expect(formatInstructionBytes(INSTRUCTION_FILE_MAX_BYTES)).toBe("100 KB");
    expect(formatInstructionBytes(120 * 1024)).toBe("120 KB");
    expect(formatInstructionBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatInstructionBytes(Number.NaN)).toBe("0 B");
  });

  it("mtime 缺失时不做格式化", () => {
    expect(formatInstructionMtime(null, "en-US")).toBeNull();
    expect(formatInstructionMtime(0, "en-US")).toBeNull();
    expect(formatInstructionMtime(USER_MTIME, "en-US")).not.toBeNull();
  });

  it("服务按形状解析：缺失或残缺时返回 null", () => {
    expect(resolveInstructionsService(null)).toBeNull();
    expect(resolveInstructionsService({} as never)).toBeNull();
    expect(
      resolveInstructionsService({
        instructionsService: { readInstructionFile: () => {} },
      } as never),
    ).toBeNull();

    const service = { readInstructionFile: vi.fn(), writeInstructionFile: vi.fn() };
    expect(resolveInstructionsService({ instructionsService: service } as never)).toBe(service);
  });
});
