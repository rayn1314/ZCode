// @vitest-environment jsdom
// 压缩摘要懒加载 hook 的契约（spec: packages/ui/spec/compact-summary-block.md 的 I2 与 §5）：
// 关掉即不请求、同一 ref 不重复请求（模块级缓存）、失败不缓存且 retry 是重读而不是回放错误。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCompactionSummaryCache, useCompactionSummary } from "@/hooks/useCompactionSummary.js";

type ReadFn = (params: { sessionId: string; messageId: string }) => Promise<{ summary: string }>;

interface Props {
  enabled: boolean;
  read?: ReadFn;
}

function renderCompactionSummary(read?: ReadFn, enabled = true) {
  return renderHook(
    (props: Props) => useCompactionSummary({ sessionId: "sess_1", messageId: "msg_1", ...props }),
    {
      initialProps: { enabled, read } satisfies Props,
    },
  );
}

describe("useCompactionSummary", () => {
  beforeEach(() => {
    resetCompactionSummaryCache();
  });

  it("折叠态（enabled=false）不发请求", () => {
    const read = vi.fn(async () => ({ summary: "body" }));
    const { result } = renderCompactionSummary(read, false);

    expect(read).not.toHaveBeenCalled();
    expect(result.current.summary).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("展开后读取一次；收起再展开命中缓存不重复请求", async () => {
    const read = vi.fn(async () => ({ summary: "Summary:\n1. 目标" }));
    const { result, rerender } = renderCompactionSummary(read, true);

    await waitFor(() => {
      expect(result.current.summary).toBe("Summary:\n1. 目标");
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ sessionId: "sess_1", messageId: "msg_1" });

    rerender({ enabled: false, read });
    rerender({ enabled: true, read });
    await waitFor(() => {
      expect(result.current.summary).toBe("Summary:\n1. 目标");
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("读取失败进错误态（不缓存），retry 触发重读并可恢复", async () => {
    const read = vi
      .fn<ReadFn>()
      .mockRejectedValueOnce(new Error("fault.compactionSummary.notFound: msg_1"))
      .mockResolvedValueOnce({ summary: "恢复后的摘要" });
    const { result } = renderCompactionSummary(read, true);

    await waitFor(() => {
      expect(result.current.error).toBe("fault.compactionSummary.notFound: msg_1");
    });
    expect(result.current.summary).toBeNull();

    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.summary).toBe("恢复后的摘要");
    });
    expect(result.current.error).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
