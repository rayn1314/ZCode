import { defineConfig } from "tsup";
// 复用 HTTP server 的编译期 define：取值方式与该文件保持一致，避免两处漂移。
import { SERVER_HTTP_DEFINES } from "./tsup.config.js";

export default defineConfig({
  entry: { "entry-relay": "src/entry-relay.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  // workspace 包的 exports 指向 .ts 源码，Node 运行时无法直接加载，必须 bundle 进来。
  // relay 只依赖 @zcode/shared（协议类型与鉴权向量），不引入 services / client。
  noExternal: ["@zcode/shared", "@zcode/rpc"],
  // ws 含可选的 bufferutil / utf-8-validate 原生加速，保持外置交给 Node 原生加载。
  external: ["ws"],
  define: SERVER_HTTP_DEFINES,
  // esbuild 不认识 tsconfig.json 里的 es2025，用专门的 tsconfig.build.json 消除 warning
  tsconfig: "tsconfig.build.json",
});
