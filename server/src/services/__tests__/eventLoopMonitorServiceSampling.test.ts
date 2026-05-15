/**
 * 事件循环采样差分顺序回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定事件循环监控在采样窗口内使用 `performance.eventLoopUtilization(current, previous)` 计算差分。
 * 2. 做什么：防止后续重构把参数顺序改回反向，导致 active/idle 出现负值后被 roundMetric 归零。
 * 3. 不做什么：不启动真实定时器，不等待真实事件循环采样窗口。
 *
 * 输入 / 输出：
 * - 输入：eventLoopMonitorService.ts 源码文本。
 * - 输出：静态结构断言结果。
 *
 * 数据流 / 状态流：
 * initializeEventLoopMonitor 建立 previous 基线 -> sampleEventLoopHealth 读取 current
 * -> Node perf_hooks 使用 current 与 previous 做窗口差分 -> 最新快照供慢日志读取。
 *
 * 复用设计说明：
 * - 复用静态源码断言方式覆盖私有采样函数，避免为了测试导出内部函数而扩大运行时 API。
 * - 与 startup pipeline 监控测试共同保护同一监控入口：一个验证生命周期接入，一个验证采样公式。
 *
 * 关键边界条件与坑点：
 * 1. Node.js 的双参数 `eventLoopUtilization` 是当前值在前、上一基线在后，反向会得到负差分。
 * 2. 此文件只检查参数顺序，不承担阈值策略校验，避免测试职责和告警策略耦合。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../eventLoopMonitorService.ts', import.meta.url), 'utf8');

const extractSampleEventLoopHealthSource = (): string => {
  const startIndex = source.indexOf('const sampleEventLoopHealth = ()');
  assert.notEqual(startIndex, -1, '缺少 sampleEventLoopHealth 私有采样函数');

  const nextFunctionIndex = source.indexOf('\nconst shouldWarnForEventLoopHealth', startIndex + 1);
  assert.notEqual(nextFunctionIndex, -1, '缺少 shouldWarnForEventLoopHealth 函数边界');

  return source.slice(startIndex, nextFunctionIndex);
};

test('sampleEventLoopHealth 应按 current、previous 顺序计算事件循环利用率差分', () => {
  const sampleSource = extractSampleEventLoopHealthSource();

  assert.match(
    sampleSource,
    /const deltaEventLoopUtilization = performance\.eventLoopUtilization\(\s*currentEventLoopUtilization,\s*previousEventLoopUtilization,\s*\);/u,
  );
  assert.doesNotMatch(
    sampleSource,
    /performance\.eventLoopUtilization\(\s*previousEventLoopUtilization,\s*currentEventLoopUtilization,\s*\)/u,
  );
});
