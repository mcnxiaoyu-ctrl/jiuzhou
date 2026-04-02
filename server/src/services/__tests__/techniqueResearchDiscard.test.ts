/**
 * 洞府研修退款流测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证主动放弃待抄写草稿时，会严格复用“草稿过期”的退款与状态流，避免 service 里再分叉一套放弃规则。
 * 2. 做什么：验证 pending 失败且已消耗顿悟符时，退款邮件会把残页与顿悟符一并发回，避免 AI 失败后玩家白白损失令牌。
 * 3. 不做什么：不连接真实数据库、不覆盖前端按钮渲染，也不验证自然过期扫描任务。
 *
 * 输入/输出：
 * - 输入：数据库查询 mock、邮件发放 mock，以及角色 ID / 生成任务 ID。
 * - 输出：放弃接口返回结果、失败退款邮件内容与任务表更新参数。
 *
 * 数据流/状态流：
 * discardGeneratedTechniqueDraft / failPendingGenerationJob -> 查询当前任务 -> 复用统一退款入口 -> 更新任务状态并发邮件。
 *
 * 关键边界条件与坑点：
 * 1. 主动放弃必须按“过期草稿”处理，不能改写成新的错误码或状态，否则前端结果语义会和自然过期分叉。
 * 2. 顿悟符只应在生成失败且任务还停留在 pending 时返还；草稿过期与主动放弃不应误退令牌，否则会破坏绕过冷却的既有成本语义。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import * as database from '../../config/database.js';
import { redis } from '../../config/redis.js';
import { mailService } from '../mailService.js';
import { TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_FRAGMENT_COST } from '../shared/techniqueResearchCost.js';
import { techniqueGenerationService, type ServiceResult } from '../techniqueGenerationService.js';

type SqlValue = boolean | Date | number | string | null;
type TechniqueResearchDiscardService = {
  discardGeneratedTechniqueDraft: (
    characterId: number,
    generationId: string,
  ) => Promise<ServiceResult<{ generationId: string }>>;
};

type MockTransactionState = {
  clientId: number;
  depth: number;
  released: boolean;
  rollbackCause: null;
  rollbackOnly: boolean;
};

const createQueryResult = <TRow extends QueryResultRow>(rows: TRow[]): QueryResult<TRow> => {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows,
    fields: [],
  };
};

const createMockPoolClient = (
  handler: (sql: string, params?: readonly SqlValue[]) => Promise<QueryResult<QueryResultRow>>,
): PoolClient => {
  const txState: MockTransactionState = {
    clientId: 1,
    depth: 0,
    released: false,
    rollbackCause: null,
    rollbackOnly: false,
  };

  const client: Partial<PoolClient> & { __txState: MockTransactionState } = {
    __txState: txState,
    query: (async (...queryArgs: Array<string | readonly SqlValue[] | { text: string }>) => {
      const firstArg = queryArgs[0];
      const sql =
        typeof firstArg === 'string'
          ? firstArg
          : typeof firstArg === 'object' && firstArg !== null && 'text' in firstArg
            ? String(firstArg.text)
            : '';
      const secondArg = queryArgs[1];
      const params = Array.isArray(secondArg) ? (secondArg as readonly SqlValue[]) : undefined;

      if (sql === 'BEGIN') {
        txState.depth = 1;
        return createQueryResult([]);
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        txState.depth = 0;
        return createQueryResult([]);
      }

      return await handler(sql, params);
    }) as PoolClient['query'],
    release: () => undefined,
  };

  return client as PoolClient;
};

test('discardGeneratedTechniqueDraft: 主动放弃草稿应按过期规则半额返还并标记为 refunded', async (t) => {
  redis.disconnect();

  const updateCalls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const sentMailPayloads: unknown[] = [];

  t.mock.method(mailService, 'sendMail', async (options: unknown) => {
    sentMailPayloads.push(options);
    return { success: true, mailId: 1001, message: '邮件发送成功' };
  });

  t.mock.method(
    database.pool,
    'connect',
    async () => createMockPoolClient(async (sql, params) => {
      if (
        sql.includes('FROM technique_generation_job')
        && sql.includes("status = 'generated_draft'")
        && sql.includes('draft_expire_at <= NOW()')
      ) {
        return createQueryResult([]);
      }

      if (
        sql.includes('FROM technique_generation_job')
        && sql.includes('WHERE id = $1 AND character_id = $2')
        && sql.includes('FOR UPDATE')
      ) {
        return createQueryResult([
          {
            status: 'generated_draft',
            cost_points: 1,
          },
        ]);
      }

      if (sql.includes('SELECT user_id') && sql.includes('FROM characters')) {
        return createQueryResult([{ user_id: 9527 }]);
      }

      if (sql.includes('UPDATE technique_generation_job') && sql.includes('SET status = $2')) {
        updateCalls.push({ sql, params: params as unknown[] | undefined });
        return createQueryResult([]);
      }

      throw new Error(`未覆盖的 SQL: ${sql}`);
    }),
  );

  const discardService = techniqueGenerationService as TechniqueResearchDiscardService;
  const result = await discardService.discardGeneratedTechniqueDraft(2712, 'research-job-1');

  assert.equal(result.success, true);
  assert.equal(result.data?.generationId, 'research-job-1');
  assert.equal(sentMailPayloads.length, 1);
  assert.deepEqual(sentMailPayloads[0], {
    recipientUserId: 9527,
    recipientCharacterId: 2712,
    senderType: 'system',
    senderName: '系统',
    mailType: 'reward',
    title: '洞府研修退款通知',
    content: '## 结果说明\n\n本次洞府研修未能成法，系统已将本次返还通过邮件发放。\n\n- 本次返还已通过邮件附件发放，请及时领取。\n\n## 结算原因\n\n> 草稿已过期，系统已通过邮件返还一半功法残页，请重新领悟 对应返还已通过邮件发放，请前往邮箱领取。',
    attachRewards: {
      items: [
        {
          itemDefId: 'mat-gongfa-canye',
          quantity: 1,
        },
      ],
    },
    expireDays: 30,
    source: 'technique_research_refund',
    sourceRefId: 'research-job-1',
    metadata: {
      generationId: 'research-job-1',
      refundFragments: 1,
      refundCooldownBypassToken: false,
      reason: '草稿已过期，系统已通过邮件返还一半功法残页，请重新领悟 对应返还已通过邮件发放，请前往邮箱领取。',
    },
  });
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0]?.params, [
    'research-job-1',
    'refunded',
    'GENERATION_EXPIRED',
    '草稿已过期，系统已通过邮件返还一半功法残页，请重新领悟 对应返还已通过邮件发放，请前往邮箱领取。',
  ]);
});

test('failPendingGenerationJob: AI 生成失败且已消耗顿悟符时应同时返还残页与顿悟符', async (t) => {
  redis.disconnect();

  const updateCalls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const sentMailPayloads: unknown[] = [];

  t.mock.method(mailService, 'sendMail', async (options: unknown) => {
    sentMailPayloads.push(options);
    return { success: true, mailId: 1002, message: '邮件发送成功' };
  });

  t.mock.method(
    database.pool,
    'connect',
    async () => createMockPoolClient(async (sql, params) => {
      if (
        sql.includes('FROM technique_generation_job')
        && sql.includes('WHERE id = $1 AND character_id = $2')
        && sql.includes('FOR UPDATE')
      ) {
        return createQueryResult([
          {
            status: 'pending',
            cost_points: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_FRAGMENT_COST,
            used_cooldown_bypass_token: true,
          },
        ]);
      }

      if (sql.includes('SELECT user_id') && sql.includes('FROM characters')) {
        return createQueryResult([{ user_id: 9527 }]);
      }

      if (sql.includes('UPDATE technique_generation_job') && sql.includes('SET status = $2')) {
        updateCalls.push({ sql, params: params as unknown[] | undefined });
        return createQueryResult([]);
      }

      throw new Error(`未覆盖的 SQL: ${sql}`);
    }),
  );

  await techniqueGenerationService.failPendingGenerationJob(
    2712,
    'research-job-2',
    'AI生成异常，已自动退款：模型超时',
  );

  assert.equal(sentMailPayloads.length, 1);
  assert.deepEqual(sentMailPayloads[0], {
    recipientUserId: 9527,
    recipientCharacterId: 2712,
    senderType: 'system',
    senderName: '系统',
    mailType: 'reward',
    title: '洞府研修退款通知',
    content: '## 结果说明\n\n本次洞府研修未能成法，系统已将本次返还通过邮件发放。\n\n- 本次返还已通过邮件附件发放，请及时领取。\n- 本次额外消耗的顿悟符也已一并返还。\n\n## 结算原因\n\n> AI生成异常，已自动退款：模型超时 对应返还已通过邮件发放，请前往邮箱领取。',
    attachRewards: {
      items: [
        {
          itemDefId: 'mat-gongfa-canye',
          quantity: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_FRAGMENT_COST,
        },
        {
          itemDefId: 'token-005',
          quantity: 1,
        },
      ],
    },
    expireDays: 30,
    source: 'technique_research_refund',
    sourceRefId: 'research-job-2',
    metadata: {
      generationId: 'research-job-2',
      refundFragments: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_FRAGMENT_COST,
      refundCooldownBypassToken: true,
      reason: 'AI生成异常，已自动退款：模型超时 对应返还已通过邮件发放，请前往邮箱领取。',
    },
  });
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0]?.params, [
    'research-job-2',
    'failed',
    'GENERATION_FAILED',
    'AI生成异常，已自动退款：模型超时 对应返还已通过邮件发放，请前往邮箱领取。',
  ]);
});
