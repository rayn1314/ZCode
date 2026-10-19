// 消息行分叉菜单里的「以当前状态分叉」门禁（复制口径 = 当前模型可见上下文）。
// 证据层 L3：父会话完成一轮 → `/compact` 产出 compact marker → 点 assistant 行 hover 工具栏的
// 分叉按钮（压缩过上下文时它是二级菜单）→ 菜单里选「以当前状态分叉」→ forkCurrentContext 命令 →
// 子会话首屏含 compact 边界，且**不含**被压缩掉的旧用户输入。证明复制口径是 activeSessionMessages
// （压缩从最后一个 compact boundary 起），而不是菜单里另一条「从这一轮完整回溯分叉」的完整可见转录。
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import { clearAppData, setInputValueByTestIdDom } from "../helpers/desktop-app.js";
import {
  clickV4ForkCurrentContext,
  clickV4Send,
  getV4CompactMarkers,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const SEED_PROMPT_TEXT = "E2E_V4_CTX_FORK_SEED";

describe("v4 会话级分叉：以当前状态分叉", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("压缩后点行级分叉菜单的「以当前状态分叉」→ child 复制的是压缩后的上下文", async () => {
    await prepareV4ConversationE2E();

    // 首轮：形成一段可被压缩的历史。
    await sendV4Prompt(`${SEED_PROMPT_TEXT} 请回复种子`);
    await waitForV4TimelineContaining("V4_CTX_FORK_SEED_OK", 45000);
    const parent = await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "父会话没有回到空闲态",
      45000,
    );
    const parentSessionId = parent.sessionId;

    // 手动压缩：走 composer slash 命令，产出 timelineMarker compact/manual/success。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15000,
      timeoutMsg: "composer 输入框没有出现",
    });
    await clickV4Send();
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);
    await waitForV4Pane((s) => !s.canStop, "compact 后父会话没有回到空闲态", 60000);

    // 分叉入口：assistant 行 hover 工具栏的分叉按钮；压缩过上下文时它是「两种方式」的二级菜单。
    await clickV4ForkCurrentContext();
    const child = await waitForV4Pane(
      (s) => s.sessionId !== null && s.sessionId !== "draft" && s.sessionId !== parentSessionId,
      "fork 后 pane 没有切到 child session",
      60000,
    );
    expect(child.sessionId).not.toBe(parentSessionId);

    // child 首屏保留压缩边界（摘要消息与其 compaction part 一起被复制）。
    await browser.waitUntil(async () => (await getV4CompactMarkers()).length > 0, {
      timeout: 30000,
      timeoutMsg: "child 首屏没有 compact marker（压缩边界没有复制过去？）",
    });
    // 复制口径 = 当前模型可见上下文：被压缩掉的旧用户输入不进 child。
    // 这是与按行回溯分叉（复制完整可见转录）最直接的区分断言。
    const childSnapshot = await getV4PaneSnapshot();
    expect(childSnapshot.timelineText).not.toContain(SEED_PROMPT_TEXT);
  });
});
