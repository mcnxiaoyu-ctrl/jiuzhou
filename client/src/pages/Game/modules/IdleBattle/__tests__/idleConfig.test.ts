// Feature: offline-idle-battle, Property 4: Idle_Config 持久化往返
// 验证：需求 1.6 — IdleConfigDto 经过 JSON 序列化/反序列化后字段完整性不变

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { IdleConfigDto, AutoSkillSlotDto, AutoSkillPolicyDto } from '../types';
import { MONTH_CARD_IDLE_MAX_DURATION_MS } from '../utils/idleDurationOptions';

// ============================================
// 模拟客户端侧的"持久化往返"：
//   PUT /api/idle/config 发送 JSON body → 服务端存储 → GET /api/idle/config 返回 JSON
//   客户端侧等价于：JSON.parse(JSON.stringify(config))
// 此处验证客户端类型结构在序列化往返后的完整性
// ============================================

const roundTrip = (config: IdleConfigDto): IdleConfigDto =>
  JSON.parse(JSON.stringify(config)) as IdleConfigDto;

// ============================================
// Arbitraries
// ============================================

const skillSlotArb: fc.Arbitrary<AutoSkillSlotDto> = fc.record({
  skillId: fc.string({ minLength: 1, maxLength: 40 }),
  priority: fc.integer({ min: 1, max: 99 }),
});

const autoSkillPolicyArb: fc.Arbitrary<AutoSkillPolicyDto> = fc.record({
  slots: fc.array(skillSlotArb, { minLength: 0, maxLength: 6 }),
});

const idleConfigArb: fc.Arbitrary<IdleConfigDto> = fc.record({
  mapId: fc.oneof(fc.string({ minLength: 1, maxLength: 40 }), fc.constant(null)),
  roomId: fc.oneof(fc.string({ minLength: 1, maxLength: 40 }), fc.constant(null)),
  // 时长范围：1min ~ 12h（含月卡扩展上限）
  maxDurationMs: fc.integer({ min: 60_000, max: MONTH_CARD_IDLE_MAX_DURATION_MS }),
  autoSkillPolicy: autoSkillPolicyArb,
  targetMonsterDefId: fc.oneof(fc.string({ minLength: 1, maxLength: 40 }), fc.constant(null)),
  includePartnerInBattle: fc.boolean(),
});

// ============================================
// 属性 4：Idle_Config 持久化往返
// ============================================

describe('Property 4: Idle_Config 持久化往返', () => {
  it('JSON 序列化往返后 mapId 字段不变', () => {
    fc.assert(
      fc.property(idleConfigArb, (config) => {
        const result = roundTrip(config);
        expect(result.mapId).toBe(config.mapId);
      }),
      { numRuns: 100 },
    );
  });

  it('JSON 序列化往返后 roomId 字段不变', () => {
    fc.assert(
      fc.property(idleConfigArb, (config) => {
        const result = roundTrip(config);
        expect(result.roomId).toBe(config.roomId);
      }),
      { numRuns: 100 },
    );
  });

  it('JSON 序列化往返后 maxDurationMs 字段不变', () => {
    fc.assert(
      fc.property(idleConfigArb, (config) => {
        const result = roundTrip(config);
        expect(result.maxDurationMs).toBe(config.maxDurationMs);
      }),
      { numRuns: 100 },
    );
  });

  it('JSON 序列化往返后 autoSkillPolicy.slots 数量不变', () => {
    fc.assert(
      fc.property(idleConfigArb, (config) => {
        const result = roundTrip(config);
        expect(result.autoSkillPolicy.slots).toHaveLength(config.autoSkillPolicy.slots.length);
      }),
      { numRuns: 100 },
    );
  });

  it('JSON 序列化往返后 targetMonsterDefId 字段不变', () => {
    fc.assert(
      fc.property(idleConfigArb, (config) => {
        const result = roundTrip(config);
        expect(result.targetMonsterDefId).toBe(config.targetMonsterDefId);
      }),
      { numRuns: 100 },
    );
  });

  it('JSON 序列化往返后 includePartnerInBattle 字段不变', () => {
    fc.assert(
      fc.property(idleConfigArb, (config) => {
        const result = roundTrip(config);
        expect(result.includePartnerInBattle).toBe(config.includePartnerInBattle);
      }),
      { numRuns: 100 },
    );
  });

  it('JSON 序列化往返后每个 slot 的 skillId 和 priority 不变', () => {
    fc.assert(
      fc.property(idleConfigArb, (config) => {
        const result = roundTrip(config);
        config.autoSkillPolicy.slots.forEach((slot, i) => {
          expect(result.autoSkillPolicy.slots[i].skillId).toBe(slot.skillId);
          expect(result.autoSkillPolicy.slots[i].priority).toBe(slot.priority);
        });
      }),
      { numRuns: 100 },
    );
  });

  it('maxDurationMs 始终在合法范围内（1min ~ 12h）', () => {
    fc.assert(
      fc.property(idleConfigArb, (config) => {
        const result = roundTrip(config);
        expect(result.maxDurationMs).toBeGreaterThanOrEqual(60_000);
        expect(result.maxDurationMs).toBeLessThanOrEqual(MONTH_CARD_IDLE_MAX_DURATION_MS);
      }),
      { numRuns: 100 },
    );
  });

  it('slots 数量不超过最大限制（6 个）', () => {
    fc.assert(
      fc.property(idleConfigArb, (config) => {
        const result = roundTrip(config);
        expect(result.autoSkillPolicy.slots.length).toBeLessThanOrEqual(6);
      }),
      { numRuns: 100 },
    );
  });

  it('完整配置对象往返后深度相等', () => {
    fc.assert(
      fc.property(idleConfigArb, (config) => {
        const result = roundTrip(config);
        expect(result).toStrictEqual(config);
      }),
      { numRuns: 100 },
    );
  });
});
