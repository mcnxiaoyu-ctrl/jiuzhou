/**
 * 伙伴回收目标选择测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定伙伴回收脚本对 `--partner-ids`、`--recruit-job-ids` 的解析、去重和模式切换规则。
 * 2. 做什么：保证“显式 ID 目标优先于底模”的行为有单一测试入口，避免 CLI、查询和摘要文案各自漂移。
 * 3. 不做什么：不连接数据库、不执行回收脚本，也不验证邮件返还逻辑。
 *
 * 输入/输出：
 * - 输入：原始 `--partner-ids` / `--recruit-job-ids` 参数、底模列表和未命中目标样本。
 * - 输出：伙伴 ID / 招募任务 ID 解析结果、目标模式对象与摘要文案断言。
 *
 * 数据流/状态流：
 * 测试样本 -> 目标选择共享模块 -> 断言解析结果与模式摘要保持稳定。
 *
 * 关键边界条件与坑点：
 * 1. 非法 ID 不能被静默忽略，否则线上误输参数会让脚本回收范围失真。
 * 2. 指定 ID 模式下必须完全忽略底模列表，不能再出现交集或并集语义。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildPartnerReclaimTargetSelector,
    buildPartnerReclaimTargetSummary,
    parseRecruitJobIdsArg,
    parsePartnerIdsArg,
} from '../../scripts/shared/partnerReclaimTargetSelector.js';

test('parsePartnerIdsArg: 应解析并去重正整数伙伴ID', () => {
    assert.deepEqual(parsePartnerIdsArg('1, 2,2, 3'), [1, 2, 3]);
});

test('parsePartnerIdsArg: 非法伙伴ID应直接报错', () => {
    assert.throws(
        () => parsePartnerIdsArg('1,abc'),
        /--partner-ids 包含非法伙伴ID：abc/u,
    );
});

test('parseRecruitJobIdsArg: 应解析并去重招募任务ID', () => {
    assert.deepEqual(
        parseRecruitJobIdsArg('partner-recruit-aaa111-1234abcd, partner-recruit-bbb222-5678efab, partner-recruit-aaa111-1234abcd'),
        ['partner-recruit-aaa111-1234abcd', 'partner-recruit-bbb222-5678efab'],
    );
});

test('parseRecruitJobIdsArg: 非法招募任务ID应直接报错', () => {
    assert.throws(
        () => parseRecruitJobIdsArg('partner-recruit-aaa111-1234abcd, bad-id'),
        /--recruit-job-ids 包含非法招募任务ID：bad-id/u,
    );
});

test('buildPartnerReclaimTargetSelector: 传入伙伴ID时应进入按伙伴ID模式并忽略其他目标', () => {
    assert.deepEqual(
        buildPartnerReclaimTargetSelector({
            baseModels: ['底模A', '底模B'],
            recruitJobIds: ['partner-recruit-aaa111-1234abcd'],
            partnerIds: [101, 102],
        }),
        {
            mode: 'partner-ids',
            partnerIds: [101, 102],
        },
    );
});

test('buildPartnerReclaimTargetSelector: 传入招募任务ID时应进入按招募任务ID模式并忽略底模', () => {
    assert.deepEqual(
        buildPartnerReclaimTargetSelector({
            baseModels: ['底模A', '底模B'],
            recruitJobIds: ['partner-recruit-aaa111-1234abcd', 'partner-recruit-bbb222-5678efab'],
            partnerIds: [],
        }),
        {
            mode: 'recruit-job-ids',
            recruitJobIds: ['partner-recruit-aaa111-1234abcd', 'partner-recruit-bbb222-5678efab'],
        },
    );
});

test('buildPartnerReclaimTargetSummary: 按ID模式应输出目标伙伴ID摘要', () => {
    const selector = buildPartnerReclaimTargetSelector({
        baseModels: ['底模A'],
        recruitJobIds: [],
        partnerIds: [101, 102, 103],
    });

    assert.deepEqual(
        buildPartnerReclaimTargetSummary({
            selector,
            unmatchedBaseModels: [],
            unmatchedRecruitJobIds: [],
            unmatchedPartnerIds: [103],
        }),
        {
            targetCountLine: '目标伙伴ID数：3',
            unmatchedLine: '未命中伙伴ID（1）：103',
        },
    );
});

test('buildPartnerReclaimTargetSummary: 按招募任务ID模式应输出目标任务摘要', () => {
    const selector = buildPartnerReclaimTargetSelector({
        baseModels: ['底模A'],
        recruitJobIds: ['partner-recruit-aaa111-1234abcd', 'partner-recruit-bbb222-5678efab'],
        partnerIds: [],
    });

    assert.deepEqual(
        buildPartnerReclaimTargetSummary({
            selector,
            unmatchedBaseModels: [],
            unmatchedRecruitJobIds: ['partner-recruit-bbb222-5678efab'],
            unmatchedPartnerIds: [],
        }),
        {
            targetCountLine: '目标招募任务ID数：2',
            unmatchedLine: '未命中招募任务ID（1）：partner-recruit-bbb222-5678efab',
        },
    );
});

test('buildPartnerReclaimTargetSummary: 按底模模式应保持原有摘要语义', () => {
    const selector = buildPartnerReclaimTargetSelector({
        baseModels: ['底模A', '底模B'],
        recruitJobIds: [],
        partnerIds: [],
    });

    assert.deepEqual(
        buildPartnerReclaimTargetSummary({
            selector,
            unmatchedBaseModels: ['底模B'],
            unmatchedRecruitJobIds: [],
            unmatchedPartnerIds: [],
        }),
        {
            targetCountLine: '目标底模数：2',
            unmatchedLine: '未命中底模（1）：底模B',
        },
    );
});
