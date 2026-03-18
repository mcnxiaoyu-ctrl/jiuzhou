import { useEffect } from 'react';

/**
 * 首页低优先级请求调度 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一承接首页这类“需要发起请求，但不必和地图/房间/任务一起抢首屏时机”的延后调度。
 * 2. 做什么：把 `setTimeout` 的挂载/清理逻辑集中起来，避免页面和模块里散落重复的延后请求 effect。
 * 3. 不做什么：不缓存请求结果，不合并 inflight，也不负责错误处理；这些仍由调用方自身负责。
 *
 * 输入/输出：
 * - 输入：`enabled` 是否启用调度、`request` 请求函数、`delayMs` 延迟毫秒数。
 * - 输出：无；到时机后直接执行调用方传入的请求函数。
 *
 * 数据流/状态流：
 * enabled 变为 true -> 安排定时器 -> 到达 delayMs 后执行 request -> 组件卸载或依赖变化时清理旧定时器。
 *
 * 关键边界条件与坑点：
 * 1. 本 Hook 只负责“延后触发一次当前 request 引用”，如果调用方在请求完成后还要重试/轮询，需要自己实现。
 * 2. `request` 应保持稳定引用；若依赖变化导致回调重建，Hook 会取消旧定时器并按新依赖重新调度，这是预期行为。
 */
export const useDeferredGameRequest = (
  enabled: boolean,
  request: () => void | Promise<void>,
  delayMs: number,
): void => {
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      void request();
    }, Math.max(0, delayMs));
    return () => {
      window.clearTimeout(timer);
    };
  }, [delayMs, enabled, request]);
};
