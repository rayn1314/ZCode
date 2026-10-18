import { useCallback, useEffect, useMemo, useState } from "react";
import { logger } from "@/logger.js";

/**
 * 一份压缩摘要的正文（会话流里的压缩块展开时才取）。读端接口
 * `v4/conversation/compactionSummary` 只按 `sessionId + messageId` 取消息正文，
 * 授权在 CLI 宿主侧（只认 `compact_summary` 消息）。
 *
 * 读取函数由调用方注入（`rowContext.readCompactionSummary`）：展示组件不自取 store /
 * transport，这是 conversationRowContext 的既有约定。
 *
 * 缓存只收**成功**的结果：摘要落库后不再改写，缓存永不过期；失败不缓存，重试就是重读。
 * 上限 64 条——单份正文实测 1.6 万 ~ 2.3 万字符，64 份约 1.5 MB 文本，是渲染进程愿意
 * 为「收起再展开不重读」付的钱（单会话实测最多 24 次压缩，实际远达不到上限）。
 */

const CACHE_CAP = 64;
const cache = new Map<string, string>();

/** 键空间用 NUL 分段：sessionId / messageId 都可能带空格等普通分隔符。 */
function cacheKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`;
}

function remember(key: string, summary: string): void {
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, summary);
}

/** 测试用：清空模块级缓存。 */
export function resetCompactionSummaryCache(): void {
  cache.clear();
}

export interface CompactionSummaryState {
  /** 摘要正文；null = 还没读到（未展开 / 加载中 / 失败）。空串是合法结果。 */
  summary: string | null;
  loading: boolean;
  error: string | null;
}

export function useCompactionSummary(options: {
  sessionId: string;
  messageId: string;
  /** 关掉即不读（折叠态、或宿主没注入读取函数）。 */
  enabled?: boolean;
  read?: (params: { sessionId: string; messageId: string }) => Promise<{ summary: string }>;
}): CompactionSummaryState & { retry: () => void } {
  const { messageId, read, sessionId } = options;
  const key = cacheKey(sessionId, messageId);
  const enabled = options.enabled !== false && sessionId.length > 0 && messageId.length > 0;
  // 失败后的重试：非零 attempt 让 effect 重跑；成功结果进缓存后重跑也只会读到缓存。
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<CompactionSummaryState>(() => {
    const cached = cache.get(key);
    return { summary: cached ?? null, loading: false, error: null };
  });

  useEffect(() => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      setState({ summary: cached, loading: false, error: null });
      return;
    }
    if (!enabled || read === undefined) {
      setState({ summary: null, loading: false, error: null });
      return;
    }
    let alive = true;
    setState({ summary: null, loading: true, error: null });
    void (async () => {
      try {
        const result = await read({ sessionId, messageId });
        if (!alive) return;
        remember(key, result.summary);
        setState({ summary: result.summary, loading: false, error: null });
      } catch (caught) {
        if (!alive) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.warn("[compaction-summary] 读取压缩摘要失败", {
          error: message,
          messageId,
          sessionId,
        });
        setState({ summary: null, loading: false, error: message });
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt, enabled, key, messageId, read, sessionId]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  return useMemo(() => ({ ...state, retry }), [retry, state]);
}
