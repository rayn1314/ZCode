import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isLocalOnlyRemoteControlUrl,
  readLocalMobileRemoteConfig,
} from "../src/main/localMobileRemoteConfig.js";

describe("isLocalOnlyRemoteControlUrl", () => {
  it("接受回环与三类私有网段", () => {
    expect(isLocalOnlyRemoteControlUrl("ws://127.0.0.1:3030/ws")).toBe(true);
    expect(isLocalOnlyRemoteControlUrl("ws://localhost:3030/ws")).toBe(true);
    expect(isLocalOnlyRemoteControlUrl("ws://[::1]:3030/ws")).toBe(true);
    expect(isLocalOnlyRemoteControlUrl("ws://10.1.2.3/ws")).toBe(true);
    expect(isLocalOnlyRemoteControlUrl("ws://192.168.3.22:3036/ws")).toBe(true);
    expect(isLocalOnlyRemoteControlUrl("ws://172.16.0.9/ws")).toBe(true);
    expect(isLocalOnlyRemoteControlUrl("ws://169.254.1.1/ws")).toBe(true);
    expect(isLocalOnlyRemoteControlUrl("http://my-nas.local:3030/remote/v4/")).toBe(true);
  });

  it("拒绝公网主机：配置文件被篡改时不能把桌面指向外部 relay", () => {
    expect(isLocalOnlyRemoteControlUrl("wss://zcode.z.ai/ws")).toBe(false);
    expect(isLocalOnlyRemoteControlUrl("https://evil.example.com/ws")).toBe(false);
  });

  it("只认明文 ws/http：局域网自托管没有证书", () => {
    expect(isLocalOnlyRemoteControlUrl("https://192.168.1.5/remote/v4/")).toBe(false);
    expect(isLocalOnlyRemoteControlUrl("ftp://192.168.1.5/x")).toBe(false);
  });

  it("拒绝非私有网段与非法输入", () => {
    expect(isLocalOnlyRemoteControlUrl("ws://172.32.0.9/ws")).toBe(false);
    expect(isLocalOnlyRemoteControlUrl("ws://8.8.8.8/ws")).toBe(false);
    expect(isLocalOnlyRemoteControlUrl("not-a-url")).toBe(false);
    expect(isLocalOnlyRemoteControlUrl("")).toBe(false);
  });
});

describe("readLocalMobileRemoteConfig", () => {
  let dataRootDir: string;

  beforeEach(() => {
    dataRootDir = mkdtempSync(join(tmpdir(), "zcode-mobile-remote-"));
  });

  afterEach(() => {
    rmSync(dataRootDir, { recursive: true, force: true });
  });

  it("缺文件时视为没有配置（官方部署行为不变）", () => {
    expect(readLocalMobileRemoteConfig(dataRootDir)).toBeNull();
  });

  it("读出自建 relay 的地址", () => {
    writeFileSync(
      join(dataRootDir, "mobile-remote.json"),
      JSON.stringify({
        relayWsUrl: "ws://192.168.3.22:3036/ws",
        remoteUrl: "http://192.168.3.22:3036/remote/v4/",
      }),
    );
    expect(readLocalMobileRemoteConfig(dataRootDir)).toEqual({
      relayWsUrl: "ws://192.168.3.22:3036/ws",
      remoteUrl: "http://192.168.3.22:3036/remote/v4/",
    });
  });

  it("任一地址指到公网就整份弃用", () => {
    writeFileSync(
      join(dataRootDir, "mobile-remote.json"),
      JSON.stringify({
        relayWsUrl: "wss://evil.example.com/ws",
        remoteUrl: "http://192.168.3.22:3036/remote/v4/",
      }),
    );
    expect(readLocalMobileRemoteConfig(dataRootDir)).toBeNull();
  });

  it("JSON 非法、字段类型错误、两个地址都空都视为没有配置", () => {
    writeFileSync(join(dataRootDir, "mobile-remote.json"), "{ not json");
    expect(readLocalMobileRemoteConfig(dataRootDir)).toBeNull();

    writeFileSync(join(dataRootDir, "mobile-remote.json"), JSON.stringify({ relayWsUrl: 42 }));
    expect(readLocalMobileRemoteConfig(dataRootDir)).toBeNull();

    writeFileSync(
      join(dataRootDir, "mobile-remote.json"),
      JSON.stringify({ relayWsUrl: "  ", remoteUrl: "" }),
    );
    expect(readLocalMobileRemoteConfig(dataRootDir)).toBeNull();
  });

  it("只填一个地址时也生效", () => {
    writeFileSync(
      join(dataRootDir, "mobile-remote.json"),
      JSON.stringify({ relayWsUrl: " ws://127.0.0.1:3030/ws " }),
    );
    expect(readLocalMobileRemoteConfig(dataRootDir)).toEqual({
      relayWsUrl: "ws://127.0.0.1:3030/ws",
      remoteUrl: "",
    });
  });
});
