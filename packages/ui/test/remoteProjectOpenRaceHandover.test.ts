import { expect, it, vi } from "vitest";
import { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";

const callerIdentity = "remote:wsl:Ubuntu:rayn:/repo";
const authoritativeIdentity = "remote:server:s1:/repo";

/**
 * 现场（2026-10-27 06:58:50-06:59:10，.tmp-window-0659）：
 * 同一项目行的连续打开会互相取代，被取代的那次在 assertCurrent 处直接回收自己刚建/刚绑好的
 * session（06:58:59.594 bind 成功 → 06:58:59.614 remote-session-disposed），后到的那次只能
 * 重新连接，形成 connect → bind → cancel 的循环。这里锁定让位语义：被取代只让位，不回收。
 */
function createScenario(options?: {
  existingSessionForCallerIdentity?: string;
  liveOwnerForAuthoritativeScope?: string;
  bindError?: Error;
  bindScopeFindsNoSession?: boolean;
}) {
  const sessions = new Map<string, { sessionId: string }>();
  if (options?.existingSessionForCallerIdentity)
    sessions.set(callerIdentity, { sessionId: options.existingSessionForCallerIdentity });
  if (options?.liveOwnerForAuthoritativeScope)
    sessions.set(authoritativeIdentity, { sessionId: options.liveOwnerForAuthoritativeScope });
  const cancel = vi.fn(async () => {});
  const connect = vi.fn(async () => "s-new");
  const bind = vi.fn(async () =>
    options?.bindError
      ? Promise.reject(options.bindError)
      : {
          workspacePath: "/repo",
          workspaceIdentity: authoritativeIdentity,
          workspacePurpose: "project",
        },
  );
  const input = {
    hostId: "h1",
    workspacePath: "/repo",
    workspaceIdentity: callerIdentity,
    remoteService: {
      connectHost: vi.fn(async () => ({
        id: "h1",
        target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
      })),
      readDirectory: vi.fn(async () => ({ hosts: [] })),
    },
    findSession: vi.fn((identity: string) =>
      options?.bindScopeFindsNoSession ? undefined : sessions.get(identity),
    ),
    connect,
    bind,
    cancel,
  } as never;
  return { input, cancel, connect, bind };
}

it("被更晚的入口取代时只让位，不回收自己创建的 session", async () => {
  const scenario = createScenario();
  let current = true;
  const input = {
    ...(scenario.input as Record<string, unknown>),
    isCurrent: () => current,
    // 连接等待期间出现更晚的打开请求：本次点击已经被取代。
    connect: vi.fn(async () => {
      current = false;
      return "s-new";
    }),
  } as never;

  await expect(attachRemoteProjectWorkspace(input)).rejects.toThrow("project.navigation-cancelled");
  expect(scenario.cancel).not.toHaveBeenCalled();
});

it("权威 scope 已有 live session 时 adopt 它，只回收本次新建的重复 session", async () => {
  const scenario = createScenario({ liveOwnerForAuthoritativeScope: "s-prev" });

  await expect(attachRemoteProjectWorkspace(scenario.input)).resolves.toBe("s-prev");
  expect(scenario.cancel).toHaveBeenCalledTimes(1);
  expect(scenario.cancel).toHaveBeenCalledWith("s-new");
  // adopt 的 session 需要一次幂等 re-bind，保证它有 renderer attachment。
  expect(scenario.bind).toHaveBeenNthCalledWith(2, "s-prev", "/repo");
});

it("无竞态时保持原路径：不 re-bind、不取消", async () => {
  const scenario = createScenario({ liveOwnerForAuthoritativeScope: "s-new" });

  await expect(attachRemoteProjectWorkspace(scenario.input)).resolves.toBe("s-new");
  expect(scenario.bind).toHaveBeenCalledTimes(1);
  expect(scenario.cancel).not.toHaveBeenCalled();
});

it("bind 之后权威 scope 没有任何 live session 仍按失败处理", async () => {
  const scenario = createScenario();

  await expect(attachRemoteProjectWorkspace(scenario.input)).rejects.toThrow(
    "project.workspace-identity-mismatch",
  );
  expect(scenario.cancel).toHaveBeenCalledWith("s-new");
});

it("bind 真失败仍然回收本次新建的 session", async () => {
  const scenario = createScenario({ bindError: new Error("remote bind failed") });

  await expect(attachRemoteProjectWorkspace(scenario.input)).rejects.toThrow("remote bind failed");
  expect(scenario.cancel).toHaveBeenCalledWith("s-new");
});

it("复用已有 session 失败时不取消别人的连接", async () => {
  const scenario = createScenario({
    existingSessionForCallerIdentity: "s-reuse",
    bindError: new Error("remote bind failed"),
  });

  await expect(attachRemoteProjectWorkspace(scenario.input)).rejects.toThrow("remote bind failed");
  expect(scenario.connect).not.toHaveBeenCalled();
  expect(scenario.cancel).not.toHaveBeenCalled();
});
