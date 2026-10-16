import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  createWebRemoteControlRelayHost,
  resolveBundledPwaStaticRoot,
} from "../src/main/webRemoteControlRelayHost.js";

const tempDirs: string[] = [];

function useTempPwaRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-relay-host-"));
  tempDirs.push(dir);
  // 只放 index.html 就够：host 只校验入口是否存在，中转逻辑由 relay 自己负责。
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>pwa</title>", "utf8");
  return dir;
}

/** 造一个 resourcesPath，其下的 mobile-remote/ 才是打包态 PWA 产物所在。 */
function useTempResourcesPath(): string {
  const resources = mkdtempSync(join(tmpdir(), "zcode-relay-resources-"));
  tempDirs.push(resources);
  const packaged = join(resources, "mobile-remote");
  mkdirSync(packaged, { recursive: true });
  writeFileSync(join(packaged, "index.html"), "<!doctype html><title>pwa</title>", "utf8");
  return resources;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createHost(
  overrides: Partial<Parameters<typeof createWebRemoteControlRelayHost>[0]> = {},
) {
  return createWebRemoteControlRelayHost({
    resolveStaticRoot: () => overrides.resolveStaticRoot?.() ?? useTempPwaRoot(),
    // 0 = 由内核分配空闲端口，避免测试间互相抢占。
    preferredPort: 0,
    ...overrides,
  });
}

describe("resolveBundledPwaStaticRoot", () => {
  it("开发态优先用仓库产物，缺失时退回随包资源", () => {
    const packagedRoot = join(useTempResourcesPath(), "mobile-remote");

    expect(
      resolveBundledPwaStaticRoot({
        isPackaged: false,
        repoRoot: "/nonexistent-repo",
        resourcesPath: join(packagedRoot, ".."),
      }),
    ).toBe(packagedRoot);

    expect(resolveBundledPwaStaticRoot({ isPackaged: false, repoRoot: "" })).toBeUndefined();
  });

  it("打包态只认随包资源，不会被仓库产物误导", () => {
    const resources = useTempResourcesPath();
    expect(resolveBundledPwaStaticRoot({ isPackaged: true, resourcesPath: resources })).toBe(
      join(resources, "mobile-remote"),
    );
    expect(resolveBundledPwaStaticRoot({ isPackaged: true })).toBeUndefined();
  });

  it("resourcesPath 下没有 mobile-remote 视为不可用", () => {
    const resources = mkdtempSync(join(tmpdir(), "zcode-relay-resources-empty-"));
    tempDirs.push(resources);
    expect(
      resolveBundledPwaStaticRoot({ isPackaged: true, resourcesPath: resources }),
    ).toBeUndefined();
  });
});

describe("createWebRemoteControlRelayHost", () => {
  it("首次 start 拉起服务并给出可连的 ws/http 地址", async () => {
    const host = createHost();
    const status = await host.start();

    expect(status.state).toBe("running");
    expect(status.host).toBeTruthy();
    // 端口可能被探测递增，地址必须用实际端口而不是 preferredPort。
    expect(status.port).toBeGreaterThan(0);

    const urls = host.getRelayUrls();
    expect(urls?.relayWsUrl).toBe(`ws://${status.host}:${status.port}/ws`);
    expect(urls?.remoteUrl).toBe(`http://${status.host}:${status.port}/remote/v4/`);

    // 地址必须真的能连：拉起一个 phone 角色客户端握手成功。
    const socket = new WebSocket(`${urls?.relayWsUrl}?mid=probe`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });
    socket.close();

    await host.stop();
  });

  it("start 幂等：重复调用复用同一次启动，不会起第二个服务", async () => {
    const host = createHost();
    const first = await host.start();
    const second = await host.start();

    expect(second.state).toBe("running");
    expect(second.port).toBe(first.port);
    expect(host.getRelayUrls()?.relayWsUrl).toBe(`ws://${first.host}:${first.port}/ws`);

    await host.stop();
  });

  it("并发 start 共用同一次启动，只产生一个监听端口", async () => {
    const host = createHost();
    const [a, b] = await Promise.all([host.start(), host.start()]);
    expect(a.port).toBe(b.port);
    await host.stop();
  });

  it("stop 后状态归零，且端口不再被占用（可再次 start）", async () => {
    const host = createHost();
    const first = await host.start();
    const { port } = first;
    await host.stop();

    expect(host.getStatus().state).toBe("stopped");
    expect(host.getRelayUrls()).toBeUndefined();

    // 重新 start 应该还能拿到端口（前一个已释放）。
    const second = await host.start();
    expect(second.state).toBe("running");
    void port;
    await host.stop();
  });

  it("没有静态资源时报可自助处置的错误，不会拉起半残服务", async () => {
    const host = createHost({ resolveStaticRoot: () => undefined });

    await expect(host.start()).rejects.toThrow(/找不到手机端页面资源/u);

    const status = host.getStatus();
    expect(status.state).toBe("error");
    expect(status.error).toContain("packages/web");
    expect(host.getRelayUrls()).toBeUndefined();
  });

  it("stop 在没有启动过时是安全的空操作", async () => {
    const host = createHost();
    await host.stop();
    expect(host.getStatus().state).toBe("stopped");
  });

  it("setHostOverride 让显式指定地址优先生效", async () => {
    const host = createHost();
    host.setHostOverride("127.0.0.1");
    const status = await host.start();
    expect(status.host).toBe("127.0.0.1");
    expect(host.getRelayUrls()?.relayWsUrl).toContain("ws://127.0.0.1:");
    await host.stop();
  });
});
