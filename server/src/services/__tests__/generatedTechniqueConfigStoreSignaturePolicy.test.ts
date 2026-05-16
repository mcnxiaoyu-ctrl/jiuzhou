/**
 * AI 生成功法快照刷新签名策略测试
 *
 * 作用：锁定快照刷新先读窄签名，签名未变化时跳过宽表加载。
 * 输入/输出：输入为 generatedTechniqueConfigStore.ts 源码文本，输出为策略断言。
 * 数据流：reload -> loadGeneratedTechniqueSnapshotSignature -> 签名比对 -> 必要时加载 def/skill/layer。
 * 复用设计说明：签名逻辑集中在配置缓存层，调用方继续使用 refreshGeneratedTechniqueSnapshots。
 * 关键边界条件与坑点：
 * 1. 签名必须覆盖 technique/skill/layer 三类 updated_at，否则技能或层级变更可能不可见。
 * 2. 首次加载不能跳过；只有已有签名且新签名相等时才返回。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../generatedTechniqueConfigStore.ts', import.meta.url), 'utf8');

test('reloadGeneratedTechniqueConfigStore 应使用快照签名跳过重复宽查询', () => {
  assert.match(source, /type GeneratedTechniqueSnapshotSignature/u);
  assert.match(source, /loadGeneratedTechniqueSnapshotSignature/u);
  assert.match(source, /isGeneratedTechniqueSnapshotSignatureEqual/u);
  assert.match(source, /lastGeneratedTechniqueSnapshotSignature/u);
});
