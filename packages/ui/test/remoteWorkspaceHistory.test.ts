// 远程 workspace 身份归并契约：target 被 canonical 化（WSL 探测出默认用户写回）后，
// 历史条目必须归并命中并沿用存量身份，不得分裂出重复条目（2026-10-02 实测事故）。
import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteTarget, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { buildRemoteWorkspaceSessionMutation } from "../src/lib/remoteWorkspaceHistory.js";

const WSL_PATH = "/home/rayn/proj";
const LEGACY_IDENTITY = "remote:wsl:Ubuntu:/home/rayn/proj";
const CANONICAL_IDENTITY = "remote:wsl:Ubuntu:rayn:/home/rayn/proj";

function buildEntry(overrides: {
  workspacePath: string;
  target: RemoteWorkspaceSessionEntry["target"];
  workspaceIdentity: string;
}): RemoteWorkspaceSessionEntry {
  return {
    kind: "remote",
    lastOpenedAt: 0,
    lastConnectionStatus: "connected",
    ...overrides,
  };
}

function buildMutation(params: {
  remoteSessions: RemoteWorkspaceSessionEntry[];
  workspacePath: string;
  target: RemoteTarget;
  workspaceIdentity?: string;
  lastConnectionStatus?: "connected" | "failed";
}) {
  return buildRemoteWorkspaceSessionMutation({
    remoteSessions: params.remoteSessions,
    workspacePath: params.workspacePath,
    target: params.target,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    lastConnectionStatus: params.lastConnectionStatus ?? "connected",
    touchOpenedAt: true,
  });
}

test("条目 target 被 canonical 化后，现算身份与存量 identity 不再逐字相等，仍必须归并命中且不新增条目", () => {
  // 还原事故形态：条目 target 已带 user（早前连接写回），identity 还是探测前的旧格式。
  const entries = [
    buildEntry({
      workspacePath: WSL_PATH,
      target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
      workspaceIdentity: LEGACY_IDENTITY,
    }),
  ];
  const mutation = buildMutation({
    remoteSessions: entries,
    workspacePath: WSL_PATH,
    target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
  });
  assert.equal(mutation.entry.workspaceIdentity, LEGACY_IDENTITY);
  assert.equal(mutation.nextRemoteSessions.length, 1);
});

test("反向同样归并：条目 target 无 user、连接 target 带 canonical user", () => {
  const mutation = buildMutation({
    remoteSessions: [
      buildEntry({
        workspacePath: WSL_PATH,
        target: { kind: "wsl", distro: "Ubuntu" },
        workspaceIdentity: LEGACY_IDENTITY,
      }),
    ],
    workspacePath: WSL_PATH,
    target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
  });
  assert.equal(mutation.entry.workspaceIdentity, LEGACY_IDENTITY);
  assert.equal(mutation.nextRemoteSessions.length, 1);
});

test("双方都显式填写 user 且不同：是两个环境，不得归并", () => {
  const mutation = buildMutation({
    remoteSessions: [
      buildEntry({
        workspacePath: WSL_PATH,
        target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
        workspaceIdentity: CANONICAL_IDENTITY,
      }),
    ],
    workspacePath: WSL_PATH,
    target: { kind: "wsl", distro: "Ubuntu", user: "root" },
  });
  assert.equal(mutation.entry.workspaceIdentity, "remote:wsl:Ubuntu:root:/home/rayn/proj");
  assert.equal(mutation.nextRemoteSessions.length, 2);
});

test("不同 distro 不归并", () => {
  const mutation = buildMutation({
    remoteSessions: [
      buildEntry({
        workspacePath: WSL_PATH,
        target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
        workspaceIdentity: CANONICAL_IDENTITY,
      }),
    ],
    workspacePath: WSL_PATH,
    target: { kind: "wsl", distro: "Debian", user: "rayn" },
  });
  assert.equal(mutation.nextRemoteSessions.length, 2);
});

test("调用方显式传入的身份不得压过归并命中的条目身份（Bot 重连场景）", () => {
  const mutation = buildMutation({
    remoteSessions: [
      buildEntry({
        workspacePath: WSL_PATH,
        target: { kind: "wsl", distro: "Ubuntu" },
        workspaceIdentity: LEGACY_IDENTITY,
      }),
    ],
    workspacePath: WSL_PATH,
    target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
    workspaceIdentity: CANONICAL_IDENTITY,
  });
  assert.equal(mutation.entry.workspaceIdentity, LEGACY_IDENTITY);
  assert.equal(mutation.nextRemoteSessions.length, 1);
});

test("失败回写沿用条目 target 快照，不被 canonical 化版本覆盖", () => {
  const mutation = buildMutation({
    remoteSessions: [
      buildEntry({
        workspacePath: WSL_PATH,
        target: { kind: "wsl", distro: "Ubuntu" },
        workspaceIdentity: LEGACY_IDENTITY,
      }),
    ],
    workspacePath: WSL_PATH,
    target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
    lastConnectionStatus: "failed",
  });
  assert.deepEqual(mutation.entry.target, { kind: "wsl", distro: "Ubuntu" });
  assert.equal(mutation.entry.workspaceIdentity, LEGACY_IDENTITY);
});

test("归并按归一化路径比对，尾斜杠噪声不导致分裂", () => {
  const mutation = buildMutation({
    remoteSessions: [
      buildEntry({
        workspacePath: `${WSL_PATH}/`,
        target: { kind: "wsl", distro: "Ubuntu" },
        workspaceIdentity: LEGACY_IDENTITY,
      }),
    ],
    workspacePath: WSL_PATH,
    target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
  });
  assert.equal(mutation.entry.workspaceIdentity, LEGACY_IDENTITY);
  assert.equal(mutation.nextRemoteSessions.length, 1);
});

test("ssh authority 完整（host/port/username 全等）才归并，docker 全等才归并", () => {
  const sshEntry = buildEntry({
    workspacePath: "/srv/app",
    target: { kind: "ssh", host: "Build.EU.example", port: 2222, username: "deploy" },
    workspaceIdentity: "remote:ssh:build.eu.example:2222:deploy:/srv/app",
  });
  const sameSsh = buildMutation({
    remoteSessions: [sshEntry],
    workspacePath: "/srv/app",
    target: { kind: "ssh", host: "build.eu.example", port: 2222, username: "deploy" },
  });
  assert.equal(sameSsh.nextRemoteSessions.length, 1);
  const differentSsh = buildMutation({
    remoteSessions: [sshEntry],
    workspacePath: "/srv/app",
    target: { kind: "ssh", host: "build.eu.example", port: 2222, username: "other" },
  });
  assert.equal(differentSsh.nextRemoteSessions.length, 2);

  const dockerEntry = buildEntry({
    workspacePath: "/srv/app",
    target: { kind: "docker", container: "builder" },
    workspaceIdentity: "remote:docker:builder:/srv/app",
  });
  const sameDocker = buildMutation({
    remoteSessions: [dockerEntry],
    workspacePath: "/srv/app",
    target: { kind: "docker", container: "builder" },
  });
  assert.equal(sameDocker.nextRemoteSessions.length, 1);
  const differentDocker = buildMutation({
    remoteSessions: [dockerEntry],
    workspacePath: "/srv/app",
    target: { kind: "docker", container: "runner" },
  });
  assert.equal(differentDocker.nextRemoteSessions.length, 2);
});

test("无既有条目时维持原语义：显式身份优先，缺省用现算", () => {
  const withExplicit = buildMutation({
    remoteSessions: [],
    workspacePath: WSL_PATH,
    target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
    workspaceIdentity: CANONICAL_IDENTITY,
  });
  assert.equal(withExplicit.entry.workspaceIdentity, CANONICAL_IDENTITY);
  const derived = buildMutation({
    remoteSessions: [],
    workspacePath: WSL_PATH,
    target: { kind: "wsl", distro: "Ubuntu", user: "rayn" },
  });
  assert.equal(derived.entry.workspaceIdentity, CANONICAL_IDENTITY);
});
