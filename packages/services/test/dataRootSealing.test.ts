import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createMemoryService } from "../src/memory/memoryService.js";
import { getZCodeDataRootDir } from "../src/paths.js";
import { sealDataRoot } from "./helpers/sealedDataRoot.js";

/**
 * 回归：宿主 shell 天然带 `ZCODE_DATA_ROOT`（ZCode 会话本身就是宿主进程的子进程），
 * 而数据根解析顺序是 `setDataRootDir > ZCODE_DATA_ROOT > {dataBaseDir}/.zcode`。
 * 封根必须压过 env——只调 `setDataBaseDir()` 会让测试读写真实用户数据根。
 * 规则见 `packages/services/spec/test-data-root-isolation.md`。
 */
test("封根压过继承的 ZCODE_DATA_ROOT，真实服务只看到临时根里的数据", async () => {
  const beforeSealing = getZCodeDataRootDir();
  let sealedBaseDir = "";

  await (async () => {
    await using root = await sealDataRoot("zcode-sealed-scope-");
    sealedBaseDir = root.baseDir;
    assert.equal(getZCodeDataRootDir(), root.dataRoot);
    assert.ok(root.dataRoot.startsWith(root.baseDir));
    assert.notEqual(getZCodeDataRootDir(), beforeSealing, "封根必须改变解析结果");

    // 关键判别点：真实服务列出的目录内容必须只有本次写入的那个项目。
    // 未封根时会读到真实用户数据根（which 有多个项目），此处即失败。
    const projectDir = join(root.dataRoot, "cli", "memories", "projects", "sealed-probe", "memory");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "MEMORY.md"), "# sealed probe\n");
    const catalog = await createMemoryService().listProjectMemories();
    assert.deepEqual(
      catalog.map((entry) => entry.id),
      ["sealed-probe"],
    );
  })();

  assert.equal(getZCodeDataRootDir(), beforeSealing, "作用域结束后应恢复原有数据根");
  assert.equal(existsSync(sealedBaseDir), false, "作用域结束后应删除临时数据根");
});
