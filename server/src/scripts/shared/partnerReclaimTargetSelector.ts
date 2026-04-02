/**
 * 伙伴回收目标选择共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中解析 `--partner-ids`、`--recruit-job-ids` 参数，并把脚本目标收口成“按底模”“按招募任务 ID”“按伙伴 ID”三种互斥模式。
 * 2. 做什么：统一生成目标摘要文案，避免 CLI、报告摘要和测试各自重复拼接模式说明。
 * 3. 不做什么：不查询数据库、不执行伙伴回收，也不决定伙伴返还内容。
 *
 * 输入/输出：
 * - 输入：原始 `--partner-ids` / `--recruit-job-ids` 字符串、底模列表、已解析的伙伴 / 招募任务 ID 列表、未命中目标列表。
 * - 输出：去重后的伙伴 / 招募任务 ID 数组、目标选择对象，以及报告摘要文案。
 *
 * 数据流/状态流：
 * CLI 参数 -> 本模块解析/收口 -> 回收脚本决定查询路径 -> 报告摘要输出目标模式信息。
 *
 * 关键边界条件与坑点：
 * 1. `--partner-ids` 只接受正整数，空串、0、负数、小数或非数字都直接报错，避免脚本静默忽略错误输入。
 * 2. `--recruit-job-ids` 只接受 `partner-recruit-<base36时间>-<8位hex>` 格式，避免把别的任务 ID 或手误字符串带进删除流程。
 * 3. 一旦进入显式 ID 模式，就必须完全忽略底模列表；这里不能再留“同时命中底模”的隐式分支。
 */

export type PartnerReclaimTargetSelector =
    | {
        mode: 'base-models';
        baseModels: string[];
    }
    | {
        mode: 'recruit-job-ids';
        recruitJobIds: string[];
    }
    | {
        mode: 'partner-ids';
        partnerIds: number[];
    };

export type PartnerReclaimTargetSummary = {
    targetCountLine: string;
    unmatchedLine: string | null;
};

const normalizePositiveInteger = (value: string): number | null => {
    if (!/^\d+$/u.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
};

const PARTNER_RECRUIT_JOB_ID_PATTERN = /^partner-recruit-[0-9a-z]+-[0-9a-f]{8}$/u;

const parseDelimitedUniqueTexts = (rawValue: string, emptyMessage: string): string[] => {
    const trimmed = rawValue.trim();
    if (!trimmed) {
        throw new Error(emptyMessage);
    }

    const seen = new Set<string>();
    const result: string[] = [];
    for (const chunk of trimmed.split(',')) {
        const normalizedChunk = chunk.trim();
        if (!normalizedChunk) {
            throw new Error(emptyMessage);
        }
        if (seen.has(normalizedChunk)) continue;
        seen.add(normalizedChunk);
        result.push(normalizedChunk);
    }
    return result;
};

export const parsePartnerIdsArg = (rawValue: string): number[] => {
    const result: number[] = [];
    const seen = new Set<number>();
    for (const normalizedChunk of parseDelimitedUniqueTexts(rawValue, '--partner-ids 不能为空')) {
        const partnerId = normalizePositiveInteger(normalizedChunk);
        if (partnerId === null) {
            throw new Error(`--partner-ids 包含非法伙伴ID：${normalizedChunk || '(空值)'}`);
        }
        if (seen.has(partnerId)) continue;
        seen.add(partnerId);
        result.push(partnerId);
    }

    if (result.length <= 0) {
        throw new Error('--partner-ids 不能为空');
    }
    return result;
};

export const parseRecruitJobIdsArg = (rawValue: string): string[] => {
    const result = parseDelimitedUniqueTexts(rawValue, '--recruit-job-ids 不能为空');
    for (const recruitJobId of result) {
        if (!PARTNER_RECRUIT_JOB_ID_PATTERN.test(recruitJobId)) {
            throw new Error(`--recruit-job-ids 包含非法招募任务ID：${recruitJobId}`);
        }
    }
    return result;
};

export const buildPartnerReclaimTargetSelector = (params: {
    baseModels: string[];
    recruitJobIds: string[];
    partnerIds: number[];
}): PartnerReclaimTargetSelector => {
    if (params.partnerIds.length > 0) {
        return {
            mode: 'partner-ids',
            partnerIds: params.partnerIds,
        };
    }
    if (params.recruitJobIds.length > 0) {
        return {
            mode: 'recruit-job-ids',
            recruitJobIds: params.recruitJobIds,
        };
    }
    return {
        mode: 'base-models',
        baseModels: params.baseModels,
    };
};

export const buildPartnerReclaimTargetSummary = (params: {
    selector: PartnerReclaimTargetSelector;
    unmatchedBaseModels: string[];
    unmatchedRecruitJobIds: string[];
    unmatchedPartnerIds: number[];
}): PartnerReclaimTargetSummary => {
    if (params.selector.mode === 'partner-ids') {
        return {
            targetCountLine: `目标伙伴ID数：${params.selector.partnerIds.length}`,
            unmatchedLine: params.unmatchedPartnerIds.length > 0
                ? `未命中伙伴ID（${params.unmatchedPartnerIds.length}）：${params.unmatchedPartnerIds.join('、')}`
                : null,
        };
    }
    if (params.selector.mode === 'recruit-job-ids') {
        return {
            targetCountLine: `目标招募任务ID数：${params.selector.recruitJobIds.length}`,
            unmatchedLine: params.unmatchedRecruitJobIds.length > 0
                ? `未命中招募任务ID（${params.unmatchedRecruitJobIds.length}）：${params.unmatchedRecruitJobIds.join('、')}`
                : null,
        };
    }

    return {
        targetCountLine: `目标底模数：${params.selector.baseModels.length}`,
        unmatchedLine: params.unmatchedBaseModels.length > 0
            ? `未命中底模（${params.unmatchedBaseModels.length}）：${params.unmatchedBaseModels.join('、')}`
            : null,
    };
};
