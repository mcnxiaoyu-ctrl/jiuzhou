/**
 * 事件循环监控启动回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定服务启动流水线必须真实调用事件循环监控初始化，而不是只打印“已就绪”。
 * 2. 做什么：锁定优雅关闭阶段会停止事件循环监控，避免测试和热重启残留定时器。
 * 3. 不做什么：不启动 HTTP 服务，不采样真实事件循环，不连接数据库。
 *
 * 输入 / 输出：
 * - 输入：startupPipeline.ts 源码文本。
 * - 输出：静态断言结果。
 *
 * 数据流 / 状态流：
 * 源码读取 -> 校验 import -> 校验 startServerWithPipeline 中 runStartupStep 调用
 * -> 校验 graceful shutdown 中 stopEventLoopMonitor 调用。
 *
 * 复用设计说明：
 * - 用静态测试锁定启动装配边界，后续调整监控实现时不需要 mock 整条启动流水线。
 * - 和现有 inventory 策略测试保持同类模式，降低测试维护成本。
 *
 * 关键边界条件与坑点：
 * 1. 不能只断言日志文本，否则仍可能出现“打印已就绪但没有启动”的回退。
 * 2. 关闭断言必须覆盖 `registerGracefulShutdown` 内部，避免监控定时器在优雅停服后残留。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

const extractNamedExportSource = (source: string, exportName: string): string => {
  const startToken = `export const ${exportName}`;
  const startIndex = source.indexOf(startToken);
  assert.notEqual(startIndex, -1, `缺少 ${exportName} 导出`);

  const nextExportIndex = source.indexOf('\nexport ', startIndex + startToken.length);
  return source.slice(startIndex, nextExportIndex === -1 ? source.length : nextExportIndex);
};

test('startupPipeline 应启动并停止事件循环监控', () => {
  const source = readSource('../../bootstrap/startupPipeline.ts');
  const gracefulShutdownSource = extractNamedExportSource(source, 'registerGracefulShutdown');

  assert.match(
    source,
    /import\s*\{(?=[^}]*\binitializeEventLoopMonitor\b)[^}]*\}\s*from\s*"..\/services\/eventLoopMonitorService\.js";/u,
  );
  assert.match(
    source,
    /import\s*\{(?=[^}]*\bstopEventLoopMonitor\b)[^}]*\}\s*from\s*"..\/services\/eventLoopMonitorService\.js";/u,
  );
  assert.match(
    source,
    /await runStartupStep\("事件循环监控初始化",\s*initializeEventLoopMonitor\);/u,
  );
  assert.match(
    gracefulShutdownSource,
    /stopEventLoopMonitor\(\);/u,
  );
});
