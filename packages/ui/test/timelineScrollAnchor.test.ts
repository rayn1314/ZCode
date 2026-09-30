// v4 时间线滚动补偿契约：测高补偿谓词与前插锚定恢复。
// 对应修复：会话切换后首次上滑「跳到很上面」+ 前插平移把同帧测高增量重复计入。
import assert from "node:assert/strict";
import test from "node:test";
import {
  prependVirtualAnchorAdjustment,
  shouldAdjustVirtualizerForItemSizeChange,
  type PrependVirtualAnchor,
} from "../src/v4/timelineScrollAnchor.js";

test("测高补偿覆盖跨视口顶边的行，否则行高变化会把视口内容整体推移", () => {
  const base = {
    following: false,
    suppressAdjustment: false,
    contentWidthChanging: false,
    scrollTop: 500,
  };
  // 整行完全在视口上方：必须补偿。
  assert.equal(shouldAdjustVirtualizerForItemSizeChange({ ...base, itemStart: 100 }), true);
  // 跨视口顶边（start 在顶之上、end 在顶之下）：历史实现的漏判点，同样必须补偿。
  assert.equal(shouldAdjustVirtualizerForItemSizeChange({ ...base, itemStart: 480 }), true);
  // 起点正好压在视口顶及以上内容为零：无需补偿（对齐 tanstack 默认谓词 item.start < scrollOffset）。
  assert.equal(shouldAdjustVirtualizerForItemSizeChange({ ...base, itemStart: 500 }), false);
  // 完全在视口内/下方：不补偿。
  assert.equal(shouldAdjustVirtualizerForItemSizeChange({ ...base, itemStart: 600 }), false);
});

test("测高补偿在 following / 恢复抑制 / 宽度变化期一律关闭", () => {
  const base = {
    suppressAdjustment: false,
    contentWidthChanging: false,
    itemStart: 0,
    scrollTop: 500,
  };
  assert.equal(shouldAdjustVirtualizerForItemSizeChange({ ...base, following: true }), false);
  assert.equal(
    shouldAdjustVirtualizerForItemSizeChange({
      ...base,
      following: false,
      suppressAdjustment: true,
    }),
    false,
  );
  assert.equal(
    shouldAdjustVirtualizerForItemSizeChange({
      ...base,
      following: false,
      contentWidthChanging: true,
    }),
    false,
  );
});

test("前插恢复是绝对目标：同帧测高增量只计入一次", () => {
  // 记录时刻：锚 unit start=0、视口偏移 offsetTop=-50（即当时 scrollTop=50）。
  const baseline: PrependVirtualAnchor = { key: "turn-1", offsetTop: -50, start: 0 };
  // 前插两行后锚 start=192（含其中一行同帧由估计 72 收敛为实测 120 的增量），
  // 且 virtualizer 已按行补偿把 scrollTop 推到 98（50 + 48）。目标视口偏移仍是 -50：
  // 期望 scrollTop = 192 + 50 = 242，即再平移 144，不得把已补偿的 48 重复计入。
  const adjustment = prependVirtualAnchorAdjustment(
    baseline,
    { key: "turn-1", offsetTop: baseline.offsetTop, start: 192 },
    98,
  );
  assert.equal(adjustment, 144);
  assert.equal(192 - (98 + adjustment), baseline.offsetTop);
});

test("前插恢复仅在锚 key 一致且数值有效时生效", () => {
  const previous: PrependVirtualAnchor = { key: "turn-1", offsetTop: -50, start: 0 };
  assert.equal(
    prependVirtualAnchorAdjustment(previous, { key: "turn-2", offsetTop: -50, start: 100 }, 10),
    null,
  );
  assert.equal(
    prependVirtualAnchorAdjustment(
      previous,
      { key: "turn-1", offsetTop: -50, start: Number.NaN },
      10,
    ),
    null,
  );
  assert.equal(
    prependVirtualAnchorAdjustment(
      previous,
      { key: "turn-1", offsetTop: -50, start: 100 },
      Number.NaN,
    ),
    null,
  );
});
