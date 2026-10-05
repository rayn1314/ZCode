// 文档事件清单一致性：apps/zcode-cli/README.md 的 "Supported hook events:" bullet
// 与根 NOTICE.md 的"生命周期 Hooks"表格行，抽取出的事件名集合必须等于 HOOK_EVENT_NAMES。
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { HOOK_EVENT_NAMES } from "../src/hooks.js";

const README_URL = new URL("../../../apps/zcode-cli/README.md", import.meta.url);
const NOTICE_URL = new URL("../../../NOTICE.md", import.meta.url);

function extractFromReadme(text: string): string[] {
  const sectionStart = text.indexOf("Supported hook events:");
  assert.ok(sectionStart >= 0, "README 中找不到 'Supported hook events:'");
  const sectionEnd = text.indexOf("Example:", sectionStart);
  assert.ok(sectionEnd > sectionStart, "README 的 hooks 段落找不到结尾 'Example:'");
  const section = text.slice(sectionStart, sectionEnd);
  const events = [...section.matchAll(/^- `([A-Za-z]+)`:/gm)].map((m) => m[1]);
  assert.equal(events.length, HOOK_EVENT_NAMES.length, "README bullet 事件数不匹配");
  return events;
}

function extractFromNotice(text: string): string[] {
  const line = text.split("\n").find((l) => l.includes("生命周期 Hooks"));
  assert.ok(line, "NOTICE 中找不到'生命周期 Hooks'表格行");
  const events = [...line.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
  assert.equal(events.length, HOOK_EVENT_NAMES.length, "NOTICE 表格行事件数不匹配");
  return events;
}

test("README 的 Supported hook events 清单与 HOOK_EVENT_NAMES 相等", async () => {
  const readme = await readFile(README_URL, "utf8");
  assert.deepEqual(new Set(extractFromReadme(readme)), new Set(HOOK_EVENT_NAMES));
});

test("NOTICE 的生命周期 Hooks 清单与 HOOK_EVENT_NAMES 相等", async () => {
  const notice = await readFile(NOTICE_URL, "utf8");
  assert.deepEqual(new Set(extractFromNotice(notice)), new Set(HOOK_EVENT_NAMES));
});
