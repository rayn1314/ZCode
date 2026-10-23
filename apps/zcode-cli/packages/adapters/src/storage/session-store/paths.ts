import { join } from "node:path";
import { resolveZCodeDataRoot } from "@zcode/contracts";

export function getDefaultSessionDbPath(): string {
  // 必须与 config 默认 sessionDbPath 用同一套数据根解析：宿主进程可按产品身份整体重定向
  // 数据根（并排安装的官方客户端与自建客户端各有独立的会话库），两个入口规则不一致就会
  // 让同一次启动解析出两个库。
  return join(resolveZCodeDataRoot(), "cli", "db", "db.sqlite");
}
