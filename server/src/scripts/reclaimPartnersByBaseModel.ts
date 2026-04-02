#!/usr/bin/env tsx

/**
 * 按伙伴招募目标批量回收伙伴脚本。
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：按 `partner_recruit_job.requested_base_model` 或 `partner_recruit_job.id` 定位已确认收下的伙伴，输出 dry run 预览，并在显式 `--execute` 时执行回收与补偿。
 * 2) 做什么：统一汇总伙伴灌注消耗经验、当前保留的已学功法书、当前保留功法的升层消耗，以及当前完整计算后属性，避免人工逐个查库。
 * 3) 不做什么：不绕过三魂归契占用约束，也不追溯已被覆盖掉的历史打书记录；坊市 active 挂单会在执行事务里先强制下架后再回收。
 *
 * 输入/输出：
 * - 输入：脚本内 `DEFAULT_TARGET_MODE` 对应的目标常量数组，以及固定生成时间截止线 `PARTNER_RECLAIM_GENERATION_CUTOFF_AT`；默认 dry run，可用 `--execute` 真正执行。
 * - 输出：控制台摘要，以及可选 `--report-file` JSON 报告；摘要与报告都会包含伙伴完整计算属性。执行模式会把高级招募令、灌注经验、功法升级消耗与功法书统一通过系统邮件返还后再删除伙伴。
 *
 * 数据流/状态流：
 * CLI 参数 -> 招募任务/伙伴实例查询 -> 伙伴功法/成长消耗汇总 -> dry run 报告 或 execute 事务（发送返还邮件 + 删除伙伴） -> 刷新角色相关缓存。
 *
 * 关键边界条件与坑点：
 * 1) 只有当前仍存在于 `character_partner`，且来源为 `partner_recruit` 的伙伴才会被处理；仅有预览、已放弃、已退款的招募任务不会命中。
 * 2) 仅按底模模式会追加 `partner_recruit_job.created_at < PARTNER_RECLAIM_GENERATION_CUTOFF_AT` 筛选，业务口径是“中国时区 2026-03-23 18:00:00 前”；显式招募任务 ID 模式不走这个时间截断。
 * 3) `character_partner_technique.learned_from_item_def_id` 只保留当前仍挂在伙伴身上的后天功法书来源；历史上已被覆盖的打书记录无法从现有表结构中精确追溯。
 */
import '../bootstrap/installConsoleLogger.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool, query, withTransaction } from '../config/database.js';
import { invalidateCharacterComputedCache } from '../services/characterComputedService.js';
import { mailService } from '../services/mailService.js';
import { cancelActivePartnerMarketListing } from '../services/shared/partnerMarketListingLifecycle.js';
import {
    PARTNER_RECLAIM_GENERATION_CUTOFF_AT,
    PARTNER_RECLAIM_GENERATION_CUTOFF_LABEL,
} from './shared/partnerReclaimGenerationCutoff.js';
import {
    buildPartnerReclaimMailContent,
    buildPartnerReclaimMailRewardPayload,
    buildPartnerReclaimMailTitle,
} from './shared/partnerReclaimMailReward.js';
import {
    buildPartnerReclaimTargetSelector,
    buildPartnerReclaimTargetSummary,
    parseRecruitJobIdsArg,
    parsePartnerIdsArg,
    type PartnerReclaimTargetSelector,
} from './shared/partnerReclaimTargetSelector.js';
import { formatPartnerReclaimComputedAttrs } from './shared/partnerReclaimComputedAttrs.js';
import {
    getItemDefinitionById,
    getPartnerDefinitionById,
    getPartnerGrowthConfig,
    refreshGeneratedPartnerSnapshots,
    refreshGeneratedTechniqueSnapshots,
} from '../services/staticConfigLoader.js';
import { scheduleActivePartnerBattleCacheRefreshByCharacterId } from '../services/battle/shared/profileCache.js';
import { calcPartnerUpgradeExpByTargetLevel } from '../services/shared/partnerRules.js';
import {
    buildPartnerDisplay,
    getPartnerTechniqueStaticMeta,
    type PartnerComputedAttrsDto,
    type PartnerRow,
} from '../services/shared/partnerView.js';
import {
    getTechniqueLayerByTechniqueAndLayerStatic,
    resolveTechniqueCostMultiplierByQuality,
    scaleTechniqueBaseCostByQuality,
} from '../services/shared/techniqueUpgradeRules.js';

type ScriptMode = 'dry-run' | 'execute';

type CliOptions = {
    mode: ScriptMode;
    recruitJobIds: string[];
    partnerIds: number[];
    reportFilePath: string | null;
};

type DefaultTargetMode = Exclude<PartnerReclaimTargetSelector['mode'], 'partner-ids'>;

type BackupRow = Record<string, unknown>;

type BackupQueryRow = {
    character_partner_row: BackupRow | null;
    partner_recruit_job_row: BackupRow | null;
};

type BackupTechniqueQueryRow = {
    row_json: BackupRow;
};

type PartnerBackupPayload = {
    backupVersion: 1;
    backupCreatedAt: string;
    reason: 'pre-delete-partner-reclaim';
    compensationItemDefId: string;
    compensationItemName: string;
    compensationQty: number;
    partnerId: number;
    ownerCharacterId: number;
    ownerUserId: number;
    generationId: string;
    baseModel: string;
    rows: {
        characterPartner: BackupRow;
        characterPartnerTechnique: BackupRow[];
        characterPartnerSkillPolicy: BackupRow[];
        partnerRecruitJob: BackupRow | null;
    };
};

type TargetPartnerRow = {
    partner_id: number;
    partner_def_id: string;
    partner_nickname: string;
    partner_description: string | null;
    partner_avatar: string | null;
    partner_level: number;
    partner_progress_exp: number;
    partner_growth_max_qixue: number;
    partner_growth_wugong: number;
    partner_growth_fagong: number;
    partner_growth_wufang: number;
    partner_growth_fafang: number;
    partner_growth_sudu: number;
    partner_is_active: boolean;
    partner_obtained_from: string;
    partner_obtained_ref_id: string | null;
    partner_created_at: Date;
    partner_updated_at: Date;
    owner_user_id: number;
    owner_character_id: number;
    owner_nickname: string;
    owner_realm: string;
    owner_sub_realm: string | null;
    recruit_job_id: string;
    requested_base_model: string;
    recruit_created_at: Date;
    active_market_listing_id: number | null;
    active_fusion_job_id: string | null;
    active_fusion_status: string | null;
};

type PartnerTechniqueRow = {
    id: number;
    partner_id: number;
    technique_id: string;
    current_layer: number;
    is_innate: boolean;
    learned_from_item_def_id: string | null;
    created_at: Date;
    updated_at: Date;
};

type TechniqueMaterialRefund = {
    itemId: string;
    itemName: string;
    qty: number;
};

type TechniqueUpgradeRefund = {
    spiritStones: number;
    exp: number;
    materials: TechniqueMaterialRefund[];
};

type LearnedTechniqueBookSummary = {
    itemDefId: string;
    itemName: string;
    techniqueId: string;
    techniqueName: string;
};

type TechniqueRefundDetail = {
    techniqueId: string;
    techniqueName: string;
    quality: string;
    currentLayer: number;
    maxLayer: number;
    isInnate: boolean;
    learnedFromItemDefId: string | null;
    learnedFromItemName: string | null;
    refund: TechniqueUpgradeRefund;
    issues: string[];
};

type TrainingRefundSummary = {
    partnerSpentExp: number;
    learnedTechniqueBooks: LearnedTechniqueBookSummary[];
    techniqueUpgradeRefund: TechniqueUpgradeRefund;
    techniqueDetails: TechniqueRefundDetail[];
    issues: string[];
};

type PartnerTargetSummary = {
    partnerId: number;
    partnerDefId: string;
    partnerName: string;
    partnerNickname: string;
    level: number;
    progressExp: number;
    isActive: boolean;
    obtainedAt: string;
    generationId: string;
    baseModel: string;
    recruitCreatedAt: string;
    ownerCharacterId: number;
    ownerUserId: number;
    ownerNickname: string;
    blockedReasons: string[];
    reclaimable: boolean;
    computedAttrs: PartnerComputedAttrsDto;
    trainingRefund: TrainingRefundSummary;
};

type PartnerExecutionResult = {
    partnerId: number;
    generationId: string;
    ownerCharacterId: number;
    mode: ScriptMode;
    status: 'executed' | 'skipped';
    compensationItemDefId: string;
    compensationItemName: string;
    compensationQty: number;
    rewardDelivery: 'mail' | null;
    rewardMailId: number | null;
    message: string;
};

type ReclaimReport = {
    mode: ScriptMode;
    targetSelector: PartnerReclaimTargetSelector;
    backupFilePath: string | null;
    compensationItemDefId: string;
    compensationItemName: string;
    compensationQtyPerPartner: number;
    baseModels: string[];
    recruitJobIds: string[];
    partnerIds: number[];
    matchedPartnerCount: number;
    reclaimablePartnerCount: number;
    blockedPartnerCount: number;
    unmatchedBaseModels: string[];
    unmatchedRecruitJobIds: string[];
    unmatchedPartnerIds: number[];
    partners: PartnerTargetSummary[];
    executionResults: PartnerExecutionResult[];
    generatedAt: string;
};

const COMPENSATION_ITEM_DEF_ID = 'token-004';
const COMPENSATION_ITEM_QTY = 1;
const ACTIVE_FUSION_JOB_STATUSES = ['pending', 'generated_preview'];
const SCRIPT_OBTAINED_FROM = 'partner_reclaim_script';
const PARTNER_RECLAIM_MAIL_EXPIRE_DAYS = 30;
const RECHECK_EXECUTABLE_PARTNER_LOCK_SQL = 'FOR UPDATE OF cp';
const DEFAULT_BACKUP_DIR = path.resolve(process.cwd(), '.tmp', 'partner-reclaim-backups');
const DEFAULT_TARGET_MODE: DefaultTargetMode = 'recruit-job-ids';
const TARGET_RECRUIT_JOB_IDS = [
    'partner-recruit-mnhm9f50-dd85662e',
    'partner-recruit-mnhm8pb8-3b9bade8',
    'partner-recruit-mnhm6wtu-838f160c',
    'partner-recruit-mnhm6hef-cbcbbb4a',
    'partner-recruit-mnhm5v2l-94dfcd71',
    'partner-recruit-mnhm5qkk-9af80bc5',
    'partner-recruit-mnhm5id7-c812edb6',
    'partner-recruit-mnhm47h9-4238967a',
    'partner-recruit-mnhm3i3z-7b8cc14e',
    'partner-recruit-mnhm2vfk-c71cad0d',
    'partner-recruit-mnhm2lkb-e882c260',
    'partner-recruit-mnhm1vvg-a6132340',
    'partner-recruit-mnhm0swt-ed481755',
    'partner-recruit-mnhm0rz1-0d4ee0b2',
    'partner-recruit-mnhlze33-99bedc87',
    'partner-recruit-mnhlzah2-d22b3542',
    'partner-recruit-mnhlyap8-df749597',
    'partner-recruit-mnhlxy1t-f18aadaf',
    'partner-recruit-mnhlwv5n-3bd12956',
    'partner-recruit-mnhlwglo-64a5a123',
    'partner-recruit-mnhlwd4x-906d2594',
    'partner-recruit-mnhlve0e-03de5c0f',
    'partner-recruit-mnhluxdh-3ecc62e5',
    'partner-recruit-mnhlmxbu-144d5c61',
    'partner-recruit-mnhlid6w-63f5add0',
    'partner-recruit-mnhledez-112f47a4',
    'partner-recruit-mnhl1q1a-3515f8b4',
    'partner-recruit-mnhkxp9s-9ea2df12',
    'partner-recruit-mnhks04y-db8f913c',
    'partner-recruit-mng5jiio-b8e27483',
    'partner-recruit-mng5fu2h-d55d90f8',
    'partner-recruit-mng5awkg-945748f2',
    'partner-recruit-mng516c5-a4794fcc',
    'partner-recruit-mng4wpo5-17c444f9',
    'partner-recruit-mng4t1mk-d59f3f11',
    'partner-recruit-mng4p3mp-eee8d6d2',
    'partner-recruit-mng4m36x-af9199a0',
    'partner-recruit-mng4i3lw-93df199f',
    'partner-recruit-mng4eq13-748bcba9',
    'partner-recruit-mng48j7h-1e7d63ef',
    'partner-recruit-mng44hr2-134fc23a',
    'partner-recruit-mng3svq2-89b9ce79',
] as const;
const TARGET_BASE_MODELS = [
    '群体六连十万血六万攻女',
    '法术群体六连击三千法攻',
    '法术群体六连击三千法攻',
    '群体法术六连击三千法攻',
    '群体物理六连击一万物攻',
    '群体连击三千法攻一千速度',
    '三千法攻加十倍光环六连击',
    '法术六连击光环三千法攻',
    '二百命中三千法攻三百速度',
    '群体三连击六千法攻一千速',
    '一千命中三千法攻一千速度',
    '七千法攻三百命中群体五连',
    '法攻光环五千法攻三百速度',
    '六连击三千法攻五百速度',
    '万血八千法攻群体五连击女',
    '三千攻五百速群体六连暴击',
    '万血九千攻群体六连击科比',
    '全体六连击六万法攻十万血',
    '群体六连击十万血五万速度',
    '群体连击十万血十万攻万速',
    '全体六连击十万血一万速度',
    '群体六连击六万攻千速万血',
    '十万血万物攻万法攻万速',
    '群体六连击十万血六万攻',
    '群体万速六连十万血六万攻',
    '女全体六连十万血六万攻万速',
    '全体六连十万血六万攻千速',
    '千速万血九千攻群体六连击',
    '万血万攻千速群体六连击女',
    '百万攻一万闪群体六连击',
    '百万攻一万闪避群体六连击',
    '全体三连击九千闪避十万攻',
    '全体六连击九千闪避十万攻',
    '七万攻群体六连击全体光环',
    '七万法攻群体六连击加光环',
    '三百攻二百防全体连击吸血',
    '一千攻防全体连击吸血龙神',
    '法攻一级提升一千上限一亿',
    '万攻万闪避万吸血群体六连',
] as const;
const HELP_TEXT = [
    '按伙伴招募目标批量回收伙伴脚本',
    '',
    '用法：',
    '  pnpm --filter ./server partner:reclaim',
    '  pnpm --filter ./server partner:reclaim -- --report-file=/tmp/reclaim-report.json',
    '  pnpm --filter ./server partner:reclaim -- --execute',
    '  pnpm --filter ./server partner:reclaim -- --recruit-job-ids=partner-recruit-xxx-1234abcd,partner-recruit-yyy-5678efab',
    '  pnpm --filter ./server partner:reclaim -- --partner-ids=101,102,103',
    '',
    '说明：',
    `  - 默认目标模式由 DEFAULT_TARGET_MODE 控制；当前为 ${DEFAULT_TARGET_MODE}。`,
    '  - 按招募任务ID模式时，目标列表直接写在脚本内的 TARGET_RECRUIT_JOB_IDS 数组中；需变更时请手动修改脚本。',
    '  - 按底模模式时，目标列表直接写在脚本内的 TARGET_BASE_MODELS 数组中；需变更时请手动修改脚本。',
    '  - 传入 --recruit-job-ids=... 后，脚本只按这些招募任务ID查询，并忽略默认目标配置。',
    '  - 传入 --partner-ids=1,2,3 后，脚本只按这些伙伴ID查询，并忽略默认目标配置。',
    '  - --recruit-job-ids 与 --partner-ids 不能同时传入。',
    '  - 默认 dry run，只输出预览和返还明细，不写数据库。',
    '  - 传入 --execute 后才会真正发送返还邮件并删除目标伙伴。',
    '  - 执行模式会在删除前把相关表行写入 .tmp/partner-reclaim-backups 下的备份文件。',
    '  - TARGET_RECRUIT_JOB_IDS 与 TARGET_BASE_MODELS 中即使有重复项，脚本也会自动去重。',
].join('\n');

const normalizeText = (value: string | null | undefined): string => {
    return typeof value === 'string' ? value.trim() : '';
};

const normalizeInteger = (value: number | string | null | undefined, fallback = 0): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.floor(parsed));
};

const resolveCompensationItemName = (): string => {
    const itemDef = getItemDefinitionById(COMPENSATION_ITEM_DEF_ID);
    return normalizeText(itemDef?.name) || COMPENSATION_ITEM_DEF_ID;
};

const parseCliOptions = (argv: string[]): CliOptions => {
    let mode: ScriptMode = 'dry-run';
    let recruitJobIds: string[] = [];
    let partnerIds: number[] = [];
    let reportFilePath: string | null = null;

    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') {
            console.log(HELP_TEXT);
            process.exit(0);
        }
        if (arg === '--execute') {
            mode = 'execute';
            continue;
        }
        if (arg === '--dry-run') {
            mode = 'dry-run';
            continue;
        }
        if (arg.startsWith('--report-file=')) {
            const value = normalizeText(arg.slice('--report-file='.length));
            if (!value) {
                throw new Error('--report-file 不能为空');
            }
            reportFilePath = value;
            continue;
        }
        if (arg.startsWith('--recruit-job-ids=')) {
            const value = normalizeText(arg.slice('--recruit-job-ids='.length));
            recruitJobIds = parseRecruitJobIdsArg(value);
            continue;
        }
        if (arg.startsWith('--partner-ids=')) {
            const value = normalizeText(arg.slice('--partner-ids='.length));
            partnerIds = parsePartnerIdsArg(value);
            continue;
        }

        throw new Error(`不支持的参数：${arg}\n\n${HELP_TEXT}`);
    }

    if (recruitJobIds.length > 0 && partnerIds.length > 0) {
        throw new Error(`--recruit-job-ids 与 --partner-ids 不能同时传入。\n\n${HELP_TEXT}`);
    }

    return {
        mode,
        recruitJobIds,
        partnerIds,
        reportFilePath,
    };
};

const resolveFilePath = (rawPath: string): string => {
    if (path.isAbsolute(rawPath)) return rawPath;
    return path.resolve(process.cwd(), rawPath);
};

const buildDefaultBackupFilePath = (): string => {
    const timestamp = new Date().toISOString().replace(/[.:]/gu, '-');
    return path.join(DEFAULT_BACKUP_DIR, `partner-reclaim-${timestamp}.jsonl`);
};

const ensureParentDirectory = async (filePath: string): Promise<void> => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
};

const appendBackupPayload = async (
    backupFilePath: string,
    payload: PartnerBackupPayload,
): Promise<void> => {
    await ensureParentDirectory(backupFilePath);
    await fs.appendFile(backupFilePath, `${JSON.stringify(payload)}\n`, 'utf8');
};

const dedupeTexts = (values: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of values) {
        const normalized = normalizeText(raw);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
};

const loadBaseModels = (): string[] => {
    const deduped = dedupeTexts([...TARGET_BASE_MODELS]);
    if (deduped.length <= 0) {
        throw new Error(`TARGET_BASE_MODELS 为空，请先在脚本里填写要回收的底模词。\n\n${HELP_TEXT}`);
    }
    return deduped;
};

const loadRecruitJobIds = (): string[] => {
    const deduped = dedupeTexts([...TARGET_RECRUIT_JOB_IDS]);
    if (deduped.length <= 0) {
        throw new Error(`TARGET_RECRUIT_JOB_IDS 为空，请先在脚本里填写要回收的招募任务ID。\n\n${HELP_TEXT}`);
    }
    return deduped;
};

const loadConfiguredTargetSelector = (): PartnerReclaimTargetSelector => {
    if (DEFAULT_TARGET_MODE === 'recruit-job-ids') {
        return buildPartnerReclaimTargetSelector({
            baseModels: [],
            recruitJobIds: loadRecruitJobIds(),
            partnerIds: [],
        });
    }
    return buildPartnerReclaimTargetSelector({
        baseModels: loadBaseModels(),
        recruitJobIds: [],
        partnerIds: [],
    });
};

const asBackupRow = (value: unknown): BackupRow | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as BackupRow;
};

const loadPartnerBackupPayload = async (params: {
    partnerId: number;
    generationId: string;
    baseModel: string;
    ownerCharacterId: number;
    ownerUserId: number;
    compensationItemName: string;
}): Promise<PartnerBackupPayload> => {
    const partnerRowResult = await query<BackupQueryRow>(
        `
      SELECT
        to_jsonb(cp) AS character_partner_row,
        to_jsonb(prj) AS partner_recruit_job_row
      FROM character_partner cp
      LEFT JOIN partner_recruit_job prj ON prj.id = cp.obtained_ref_id
      WHERE cp.id = $1
    `,
        [params.partnerId],
    );
    const partnerRow = partnerRowResult.rows[0];
    const characterPartnerRow = asBackupRow(partnerRow?.character_partner_row);
    if (!characterPartnerRow) {
        throw new Error(`备份失败：未找到伙伴行 ${params.partnerId}`);
    }

    const techniqueResult = await query<BackupTechniqueQueryRow>(
        `
      SELECT to_jsonb(cpt) AS row_json
      FROM character_partner_technique cpt
      WHERE cpt.partner_id = $1
      ORDER BY cpt.created_at ASC, cpt.id ASC
    `,
        [params.partnerId],
    );
    const skillPolicyResult = await query<BackupTechniqueQueryRow>(
        `
      SELECT to_jsonb(cpsp) AS row_json
      FROM character_partner_skill_policy cpsp
      WHERE cpsp.partner_id = $1
      ORDER BY cpsp.priority ASC, cpsp.id ASC
    `,
        [params.partnerId],
    );

    return {
        backupVersion: 1,
        backupCreatedAt: new Date().toISOString(),
        reason: 'pre-delete-partner-reclaim',
        compensationItemDefId: COMPENSATION_ITEM_DEF_ID,
        compensationItemName: params.compensationItemName,
        compensationQty: COMPENSATION_ITEM_QTY,
        partnerId: params.partnerId,
        ownerCharacterId: params.ownerCharacterId,
        ownerUserId: params.ownerUserId,
        generationId: params.generationId,
        baseModel: params.baseModel,
        rows: {
            characterPartner: characterPartnerRow,
            characterPartnerTechnique: techniqueResult.rows
                .map((row) => asBackupRow(row.row_json))
                .filter((row): row is BackupRow => row !== null),
            characterPartnerSkillPolicy: skillPolicyResult.rows
                .map((row) => asBackupRow(row.row_json))
                .filter((row): row is BackupRow => row !== null),
            partnerRecruitJob: asBackupRow(partnerRow?.partner_recruit_job_row),
        },
    };
};

const buildPartnerSpentExp = (level: number, progressExp: number): number => {
    const safeLevel = Math.max(1, normalizeInteger(level, 1));
    const safeProgressExp = normalizeInteger(progressExp, 0);
    const growthConfig = getPartnerGrowthConfig();
    let total = safeProgressExp;
    for (let targetLevel = 2; targetLevel <= safeLevel; targetLevel += 1) {
        total += calcPartnerUpgradeExpByTargetLevel(targetLevel, growthConfig);
    }
    return total;
};

const loadTargetPartners = async (baseModels: string[]): Promise<TargetPartnerRow[]> => {
    const result = await query<TargetPartnerRow>(
        `
      SELECT
        cp.id AS partner_id,
        cp.partner_def_id,
        cp.nickname AS partner_nickname,
        cp.description AS partner_description,
        cp.avatar AS partner_avatar,
        cp.level AS partner_level,
        cp.progress_exp AS partner_progress_exp,
        cp.growth_max_qixue AS partner_growth_max_qixue,
        cp.growth_wugong AS partner_growth_wugong,
        cp.growth_fagong AS partner_growth_fagong,
        cp.growth_wufang AS partner_growth_wufang,
        cp.growth_fafang AS partner_growth_fafang,
        cp.growth_sudu AS partner_growth_sudu,
        cp.is_active AS partner_is_active,
        cp.obtained_from AS partner_obtained_from,
        cp.obtained_ref_id AS partner_obtained_ref_id,
        cp.created_at AS partner_created_at,
        cp.updated_at AS partner_updated_at,
        c.user_id AS owner_user_id,
        c.id AS owner_character_id,
        c.nickname AS owner_nickname,
        c.realm AS owner_realm,
        c.sub_realm AS owner_sub_realm,
        prj.id AS recruit_job_id,
        prj.requested_base_model,
        prj.created_at AS recruit_created_at,
        mpl.id AS active_market_listing_id,
        pfj.fusion_job_id AS active_fusion_job_id,
        pfj.status AS active_fusion_status
      FROM character_partner cp
      JOIN partner_recruit_job prj
        ON cp.obtained_from = 'partner_recruit'
       AND cp.obtained_ref_id = prj.id
      JOIN characters c
        ON c.id = cp.character_id
      LEFT JOIN LATERAL (
        SELECT id
        FROM market_partner_listing
        WHERE partner_id = cp.id
          AND status = 'active'
        ORDER BY id DESC
        LIMIT 1
      ) mpl ON TRUE
      LEFT JOIN LATERAL (
        SELECT j.id AS fusion_job_id, j.status
        FROM partner_fusion_job_material m
        JOIN partner_fusion_job j
          ON j.id = m.fusion_job_id
        WHERE m.partner_id = cp.id
          AND j.status = ANY($2::text[])
        ORDER BY j.created_at DESC
        LIMIT 1
      ) pfj ON TRUE
      WHERE btrim(prj.requested_base_model) = ANY($1::text[])
        AND prj.created_at < $3
      ORDER BY btrim(prj.requested_base_model) ASC, cp.created_at DESC, cp.id DESC
    `,
        [baseModels, ACTIVE_FUSION_JOB_STATUSES, PARTNER_RECLAIM_GENERATION_CUTOFF_AT],
    );
    return result.rows;
};

const loadTargetPartnersByIds = async (partnerIds: number[]): Promise<TargetPartnerRow[]> => {
    const normalizedPartnerIds = [...new Set(partnerIds.filter((partnerId) => partnerId > 0))];
    if (normalizedPartnerIds.length <= 0) return [];

    const result = await query<TargetPartnerRow>(
        `
      SELECT
        cp.id AS partner_id,
        cp.partner_def_id,
        cp.nickname AS partner_nickname,
        cp.description AS partner_description,
        cp.avatar AS partner_avatar,
        cp.level AS partner_level,
        cp.progress_exp AS partner_progress_exp,
        cp.growth_max_qixue AS partner_growth_max_qixue,
        cp.growth_wugong AS partner_growth_wugong,
        cp.growth_fagong AS partner_growth_fagong,
        cp.growth_wufang AS partner_growth_wufang,
        cp.growth_fafang AS partner_growth_fafang,
        cp.growth_sudu AS partner_growth_sudu,
        cp.is_active AS partner_is_active,
        cp.obtained_from AS partner_obtained_from,
        cp.obtained_ref_id AS partner_obtained_ref_id,
        cp.created_at AS partner_created_at,
        cp.updated_at AS partner_updated_at,
        c.user_id AS owner_user_id,
        c.id AS owner_character_id,
        c.nickname AS owner_nickname,
        c.realm AS owner_realm,
        c.sub_realm AS owner_sub_realm,
        prj.id AS recruit_job_id,
        prj.requested_base_model,
        prj.created_at AS recruit_created_at,
        mpl.id AS active_market_listing_id,
        pfj.fusion_job_id AS active_fusion_job_id,
        pfj.status AS active_fusion_status
      FROM character_partner cp
      JOIN partner_recruit_job prj
        ON cp.obtained_from = 'partner_recruit'
       AND cp.obtained_ref_id = prj.id
      JOIN characters c
        ON c.id = cp.character_id
      LEFT JOIN LATERAL (
        SELECT id
        FROM market_partner_listing
        WHERE partner_id = cp.id
          AND status = 'active'
        ORDER BY id DESC
        LIMIT 1
      ) mpl ON TRUE
      LEFT JOIN LATERAL (
        SELECT j.id AS fusion_job_id, j.status
        FROM partner_fusion_job_material m
        JOIN partner_fusion_job j
          ON j.id = m.fusion_job_id
        WHERE m.partner_id = cp.id
          AND j.status = ANY($2::text[])
        ORDER BY j.created_at DESC
        LIMIT 1
      ) pfj ON TRUE
      WHERE cp.id = ANY($1::int[])
      ORDER BY array_position($1::int[], cp.id), cp.created_at DESC, cp.id DESC
    `,
        [normalizedPartnerIds, ACTIVE_FUSION_JOB_STATUSES],
    );
    return result.rows;
};

const loadTargetPartnersByRecruitJobIds = async (recruitJobIds: string[]): Promise<TargetPartnerRow[]> => {
    const normalizedRecruitJobIds = dedupeTexts(recruitJobIds);
    if (normalizedRecruitJobIds.length <= 0) return [];

    const result = await query<TargetPartnerRow>(
        `
      SELECT
        cp.id AS partner_id,
        cp.partner_def_id,
        cp.nickname AS partner_nickname,
        cp.description AS partner_description,
        cp.avatar AS partner_avatar,
        cp.level AS partner_level,
        cp.progress_exp AS partner_progress_exp,
        cp.growth_max_qixue AS partner_growth_max_qixue,
        cp.growth_wugong AS partner_growth_wugong,
        cp.growth_fagong AS partner_growth_fagong,
        cp.growth_wufang AS partner_growth_wufang,
        cp.growth_fafang AS partner_growth_fafang,
        cp.growth_sudu AS partner_growth_sudu,
        cp.is_active AS partner_is_active,
        cp.obtained_from AS partner_obtained_from,
        cp.obtained_ref_id AS partner_obtained_ref_id,
        cp.created_at AS partner_created_at,
        cp.updated_at AS partner_updated_at,
        c.user_id AS owner_user_id,
        c.id AS owner_character_id,
        c.nickname AS owner_nickname,
        c.realm AS owner_realm,
        c.sub_realm AS owner_sub_realm,
        prj.id AS recruit_job_id,
        prj.requested_base_model,
        prj.created_at AS recruit_created_at,
        mpl.id AS active_market_listing_id,
        pfj.fusion_job_id AS active_fusion_job_id,
        pfj.status AS active_fusion_status
      FROM character_partner cp
      JOIN partner_recruit_job prj
        ON cp.obtained_from = 'partner_recruit'
       AND cp.obtained_ref_id = prj.id
      JOIN characters c
        ON c.id = cp.character_id
      LEFT JOIN LATERAL (
        SELECT id
        FROM market_partner_listing
        WHERE partner_id = cp.id
          AND status = 'active'
        ORDER BY id DESC
        LIMIT 1
      ) mpl ON TRUE
      LEFT JOIN LATERAL (
        SELECT j.id AS fusion_job_id, j.status
        FROM partner_fusion_job_material m
        JOIN partner_fusion_job j
          ON j.id = m.fusion_job_id
        WHERE m.partner_id = cp.id
          AND j.status = ANY($2::text[])
        ORDER BY j.created_at DESC
        LIMIT 1
      ) pfj ON TRUE
      WHERE prj.id = ANY($1::text[])
      ORDER BY array_position($1::text[], prj.id), cp.created_at DESC, cp.id DESC
    `,
        [normalizedRecruitJobIds, ACTIVE_FUSION_JOB_STATUSES],
    );
    return result.rows;
};

const loadTargetPartnersBySelector = async (
    selector: PartnerReclaimTargetSelector,
): Promise<TargetPartnerRow[]> => {
    if (selector.mode === 'partner-ids') {
        return loadTargetPartnersByIds(selector.partnerIds);
    }
    if (selector.mode === 'recruit-job-ids') {
        return loadTargetPartnersByRecruitJobIds(selector.recruitJobIds);
    }
    return loadTargetPartners(selector.baseModels);
};

const loadPartnerTechniques = async (partnerIds: number[]): Promise<Map<number, PartnerTechniqueRow[]>> => {
    const normalizedPartnerIds = [...new Set(partnerIds.filter((partnerId) => partnerId > 0))];
    const resultMap = new Map<number, PartnerTechniqueRow[]>();
    if (normalizedPartnerIds.length <= 0) return resultMap;

    const result = await query<PartnerTechniqueRow>(
        `
      SELECT
        id,
        partner_id,
        technique_id,
        current_layer,
        is_innate,
        learned_from_item_def_id,
        created_at,
        updated_at
      FROM character_partner_technique
      WHERE partner_id = ANY($1::int[])
      ORDER BY created_at ASC, id ASC
    `,
        [normalizedPartnerIds],
    );

    for (const row of result.rows) {
        const list = resultMap.get(row.partner_id) ?? [];
        list.push(row);
        resultMap.set(row.partner_id, list);
    }
    return resultMap;
};

const mergeTechniqueMaterials = (
    target: Map<string, TechniqueMaterialRefund>,
    materials: TechniqueMaterialRefund[],
): void => {
    for (const material of materials) {
        const current = target.get(material.itemId);
        if (!current) {
            target.set(material.itemId, { ...material });
            continue;
        }
        current.qty += material.qty;
    }
};

const sortTechniqueMaterials = (materials: TechniqueMaterialRefund[]): TechniqueMaterialRefund[] => {
    return [...materials].sort((left, right) => {
        if (right.qty !== left.qty) return right.qty - left.qty;
        return left.itemId.localeCompare(right.itemId, 'zh-CN');
    });
};

const buildTechniqueRefundDetail = (row: PartnerTechniqueRow): TechniqueRefundDetail => {
    const techniqueMeta = getPartnerTechniqueStaticMeta(row.technique_id, row.current_layer);
    const learnedFromItemDefId = normalizeText(row.learned_from_item_def_id) || null;
    const learnedFromItemName = learnedFromItemDefId
        ? normalizeText(getItemDefinitionById(learnedFromItemDefId)?.name) || learnedFromItemDefId
        : null;

    if (!techniqueMeta) {
        return {
            techniqueId: row.technique_id,
            techniqueName: row.technique_id,
            quality: '--',
            currentLayer: Math.max(1, normalizeInteger(row.current_layer, 1)),
            maxLayer: Math.max(1, normalizeInteger(row.current_layer, 1)),
            isInnate: row.is_innate,
            learnedFromItemDefId,
            learnedFromItemName,
            refund: {
                spiritStones: 0,
                exp: 0,
                materials: [],
            },
            issues: [`功法定义不存在或未启用：${row.technique_id}`],
        };
    }

    const qualityMultiplier = resolveTechniqueCostMultiplierByQuality(techniqueMeta.definition.quality);
    const materialMap = new Map<string, TechniqueMaterialRefund>();
    let spiritStones = 0;
    let exp = 0;
    const issues: string[] = [];

    for (let layer = 2; layer <= techniqueMeta.currentLayer; layer += 1) {
        const layerConfig = getTechniqueLayerByTechniqueAndLayerStatic(row.technique_id, layer);
        if (!layerConfig) {
            issues.push(`缺少第 ${layer} 层静态配置`);
            continue;
        }
        spiritStones += scaleTechniqueBaseCostByQuality(layerConfig.costSpiritStones, qualityMultiplier);
        exp += scaleTechniqueBaseCostByQuality(layerConfig.costExp, qualityMultiplier);
        mergeTechniqueMaterials(
            materialMap,
            layerConfig.costMaterials.map((entry) => ({
                itemId: entry.itemId,
                itemName: normalizeText(getItemDefinitionById(entry.itemId)?.name) || entry.itemId,
                qty: entry.qty,
            })),
        );
    }

    return {
        techniqueId: row.technique_id,
        techniqueName: normalizeText(techniqueMeta.definition.name) || row.technique_id,
        quality: normalizeText(techniqueMeta.definition.quality) || '--',
        currentLayer: techniqueMeta.currentLayer,
        maxLayer: techniqueMeta.maxLayer,
        isInnate: row.is_innate,
        learnedFromItemDefId,
        learnedFromItemName,
        refund: {
            spiritStones,
            exp,
            materials: sortTechniqueMaterials([...materialMap.values()]),
        },
        issues,
    };
};

const buildTrainingRefundSummary = (row: TargetPartnerRow, techniqueRows: PartnerTechniqueRow[]): TrainingRefundSummary => {
    const techniqueMaterialMap = new Map<string, TechniqueMaterialRefund>();
    const techniqueDetails = techniqueRows.map((techniqueRow) => buildTechniqueRefundDetail(techniqueRow));
    const issues = techniqueDetails.flatMap((detail) => detail.issues);

    for (const detail of techniqueDetails) {
        mergeTechniqueMaterials(techniqueMaterialMap, detail.refund.materials);
    }

    const learnedTechniqueBooks = techniqueDetails
        .filter((detail) => detail.learnedFromItemDefId !== null)
        .map((detail) => ({
            itemDefId: detail.learnedFromItemDefId ?? '',
            itemName: detail.learnedFromItemName ?? detail.learnedFromItemDefId ?? '',
            techniqueId: detail.techniqueId,
            techniqueName: detail.techniqueName,
        }));

    return {
        partnerSpentExp: buildPartnerSpentExp(row.partner_level, row.partner_progress_exp),
        learnedTechniqueBooks,
        techniqueUpgradeRefund: {
            spiritStones: techniqueDetails.reduce((sum, detail) => sum + detail.refund.spiritStones, 0),
            exp: techniqueDetails.reduce((sum, detail) => sum + detail.refund.exp, 0),
            materials: sortTechniqueMaterials([...techniqueMaterialMap.values()]),
        },
        techniqueDetails,
        issues,
    };
};

const buildBlockedReasons = (row: TargetPartnerRow): string[] => {
    const blockedReasons: string[] = [];
    if (row.active_fusion_job_id !== null) {
        const fusionStatus = normalizeText(row.active_fusion_status) || 'unknown';
        blockedReasons.push(`三魂归契占用中（fusionJobId=${row.active_fusion_job_id}, status=${fusionStatus}）`);
    }
    return blockedReasons;
};

const buildPartnerName = async (row: TargetPartnerRow): Promise<string> => {
    const definition = await getPartnerDefinitionById(row.partner_def_id);
    return normalizeText(definition?.name) || row.partner_def_id;
};

const toPartnerDisplayRow = (row: TargetPartnerRow): PartnerRow => {
    return {
        id: row.partner_id,
        character_id: row.owner_character_id,
        partner_def_id: row.partner_def_id,
        nickname: row.partner_nickname,
        description: row.partner_description,
        avatar: row.partner_avatar,
        level: row.partner_level,
        progress_exp: row.partner_progress_exp,
        growth_max_qixue: row.partner_growth_max_qixue,
        growth_wugong: row.partner_growth_wugong,
        growth_fagong: row.partner_growth_fagong,
        growth_wufang: row.partner_growth_wufang,
        growth_fafang: row.partner_growth_fafang,
        growth_sudu: row.partner_growth_sudu,
        is_active: row.partner_is_active,
        obtained_from: row.partner_obtained_from,
        obtained_ref_id: row.partner_obtained_ref_id,
        created_at: row.partner_created_at,
        updated_at: row.partner_updated_at,
    };
};

const buildPartnerComputedAttrs = async (
    row: TargetPartnerRow,
    techniqueRows: PartnerTechniqueRow[],
): Promise<PartnerComputedAttrsDto> => {
    const definition = await getPartnerDefinitionById(row.partner_def_id);
    if (!definition) {
        throw new Error(`伙伴模板不存在: ${row.partner_def_id}`);
    }

    return buildPartnerDisplay({
        row: toPartnerDisplayRow(row),
        definition,
        techniqueRows,
        ownerRealm: {
            realm: normalizeText(row.owner_realm) || '凡人',
            subRealm: normalizeText(row.owner_sub_realm) || null,
        },
    }).computedAttrs;
};

const buildPartnerSummaries = async (
    partnerRows: TargetPartnerRow[],
    techniqueMap: Map<number, PartnerTechniqueRow[]>,
): Promise<PartnerTargetSummary[]> => {
    return Promise.all(partnerRows.map(async (row) => {
        const blockedReasons = buildBlockedReasons(row);
        const techniqueRows = techniqueMap.get(row.partner_id) ?? [];
        const computedAttrs = await buildPartnerComputedAttrs(row, techniqueRows);
        const partnerName = await buildPartnerName(row);
        return {
            partnerId: row.partner_id,
            partnerDefId: row.partner_def_id,
            partnerName,
            partnerNickname: normalizeText(row.partner_nickname) || partnerName,
            level: normalizeInteger(row.partner_level, 1),
            progressExp: normalizeInteger(row.partner_progress_exp, 0),
            isActive: row.partner_is_active,
            obtainedAt: row.partner_created_at.toISOString(),
            generationId: normalizeText(row.recruit_job_id),
            baseModel: normalizeText(row.requested_base_model),
            recruitCreatedAt: row.recruit_created_at.toISOString(),
            ownerCharacterId: normalizeInteger(row.owner_character_id, 0),
            ownerUserId: normalizeInteger(row.owner_user_id, 0),
            ownerNickname: normalizeText(row.owner_nickname) || String(row.owner_character_id),
            blockedReasons,
            reclaimable: blockedReasons.length === 0,
            computedAttrs,
            trainingRefund: buildTrainingRefundSummary(row, techniqueRows),
        };
    }));
};

const writeReportFile = async (reportFilePath: string, report: ReclaimReport): Promise<void> => {
    const resolvedPath = resolveFilePath(reportFilePath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
};

const printReportSummary = (report: ReclaimReport): void => {
    console.log(`模式：${report.mode === 'execute' ? '执行' : 'dry run'}`);
    if (report.backupFilePath) {
        console.log(`备份文件：${report.backupFilePath}`);
    }
    const targetSummary = buildPartnerReclaimTargetSummary({
        selector: report.targetSelector,
        unmatchedBaseModels: report.unmatchedBaseModels,
        unmatchedRecruitJobIds: report.unmatchedRecruitJobIds,
        unmatchedPartnerIds: report.unmatchedPartnerIds,
    });
    console.log(targetSummary.targetCountLine);
    if (report.targetSelector.mode === 'base-models') {
        console.log(`生成时间截止：${PARTNER_RECLAIM_GENERATION_CUTOFF_LABEL}`);
    }
    console.log(`命中伙伴数：${report.matchedPartnerCount}`);
    console.log(`可回收伙伴数：${report.reclaimablePartnerCount}`);
    console.log(`阻塞伙伴数：${report.blockedPartnerCount}`);
    console.log('返还方式：系统邮件');
    console.log(`补偿：${report.compensationItemName} x ${report.compensationQtyPerPartner}（与训练返还明细一并发邮件）`);
    if (targetSummary.unmatchedLine) {
        console.log(targetSummary.unmatchedLine);
    }

    for (const partner of report.partners) {
        const statusLabel = partner.reclaimable ? '可回收' : `阻塞：${partner.blockedReasons.join('；')}`;
        console.log(
            [
                '',
                `- 伙伴 #${partner.partnerId}【${partner.partnerNickname}】/${partner.partnerName}`,
                `  招募任务：${partner.generationId}`,
                `  所属角色：#${partner.ownerCharacterId} ${partner.ownerNickname}`,
                `  底模：${partner.baseModel}`,
                `  状态：${statusLabel}`,
                '  坊市挂单：若存在 active 挂单则执行时强制下架',
                `  伙伴灌注经验：${partner.trainingRefund.partnerSpentExp}`,
                `  当前保留功法书：${partner.trainingRefund.learnedTechniqueBooks.length === 0
                    ? '无'
                    : partner.trainingRefund.learnedTechniqueBooks.map((entry) => `${entry.itemName} -> ${entry.techniqueName}`).join('；')}`,
                `  当前保留功法升级返还：灵石 ${partner.trainingRefund.techniqueUpgradeRefund.spiritStones}，经验 ${partner.trainingRefund.techniqueUpgradeRefund.exp}`,
            ].join('\n'),
        );
        for (const attrsLine of formatPartnerReclaimComputedAttrs(partner.computedAttrs)) {
            console.log(`  伙伴属性：${attrsLine}`);
        }
        if (partner.trainingRefund.techniqueUpgradeRefund.materials.length > 0) {
            console.log(
                `  当前保留功法升级材料：${partner.trainingRefund.techniqueUpgradeRefund.materials
                    .map((entry) => `${entry.itemName} x ${entry.qty}`)
                    .join('；')}`,
            );
        }
        if (partner.trainingRefund.issues.length > 0) {
            console.log(`  注意：${partner.trainingRefund.issues.join('；')}`);
        }
    }
};

const buildReport = async (params: {
    mode: ScriptMode;
    targetSelector: PartnerReclaimTargetSelector;
    backupFilePath: string | null;
}): Promise<ReclaimReport> => {
    await refreshGeneratedTechniqueSnapshots();
    await refreshGeneratedPartnerSnapshots();

    const partnerRows = await loadTargetPartnersBySelector(params.targetSelector);
    const techniqueMap = await loadPartnerTechniques(partnerRows.map((row) => row.partner_id));
    const partners = await buildPartnerSummaries(partnerRows, techniqueMap);
    const matchedBaseModelSet = new Set(partners.map((partner) => partner.baseModel));
    const matchedRecruitJobIdSet = new Set(partners.map((partner) => partner.generationId));
    const matchedPartnerIdSet = new Set(partners.map((partner) => partner.partnerId));
    const baseModels = params.targetSelector.mode === 'base-models' ? params.targetSelector.baseModels : [];
    const recruitJobIds = params.targetSelector.mode === 'recruit-job-ids' ? params.targetSelector.recruitJobIds : [];
    const partnerIds = params.targetSelector.mode === 'partner-ids' ? params.targetSelector.partnerIds : [];

    return {
        mode: params.mode,
        targetSelector: params.targetSelector,
        backupFilePath: params.backupFilePath,
        compensationItemDefId: COMPENSATION_ITEM_DEF_ID,
        compensationItemName: resolveCompensationItemName(),
        compensationQtyPerPartner: COMPENSATION_ITEM_QTY,
        baseModels,
        recruitJobIds,
        partnerIds,
        matchedPartnerCount: partners.length,
        reclaimablePartnerCount: partners.filter((partner) => partner.reclaimable).length,
        blockedPartnerCount: partners.filter((partner) => !partner.reclaimable).length,
        unmatchedBaseModels: baseModels.filter((baseModel) => !matchedBaseModelSet.has(baseModel)),
        unmatchedRecruitJobIds: recruitJobIds.filter((recruitJobId) => !matchedRecruitJobIdSet.has(recruitJobId)),
        unmatchedPartnerIds: partnerIds.filter((partnerId) => !matchedPartnerIdSet.has(partnerId)),
        partners,
        executionResults: [],
        generatedAt: new Date().toISOString(),
    };
};

const sendPartnerReclaimRewardMail = async (params: {
    partner: PartnerTargetSummary;
    ownerUserId: number;
    ownerCharacterId: number;
    generationId: string;
}): Promise<{
    success: boolean;
    message: string;
    mailId: number | null;
}> => {
    const rewardPayload = buildPartnerReclaimMailRewardPayload({
        compensationItemDefId: COMPENSATION_ITEM_DEF_ID,
        compensationQty: COMPENSATION_ITEM_QTY,
        partnerSpentExp: params.partner.trainingRefund.partnerSpentExp,
        learnedTechniqueBooks: params.partner.trainingRefund.learnedTechniqueBooks,
        techniqueUpgradeRefund: params.partner.trainingRefund.techniqueUpgradeRefund,
    });

    const mailResult = await mailService.sendMail({
        recipientUserId: params.ownerUserId,
        recipientCharacterId: params.ownerCharacterId,
        senderType: 'system',
        senderName: '系统',
        mailType: 'reward',
        title: buildPartnerReclaimMailTitle(),
        content: buildPartnerReclaimMailContent({
            partnerNickname: params.partner.partnerNickname,
            partnerName: params.partner.partnerName,
            baseModel: params.partner.baseModel,
        }),
        attachRewards: rewardPayload,
        expireDays: PARTNER_RECLAIM_MAIL_EXPIRE_DAYS,
        source: SCRIPT_OBTAINED_FROM,
        sourceRefId: params.generationId,
        metadata: {
            partnerId: params.partner.partnerId,
            partnerDefId: params.partner.partnerDefId,
            partnerNickname: params.partner.partnerNickname,
            baseModel: params.partner.baseModel,
        },
    });

    return {
        success: mailResult.success,
        message: mailResult.message,
        mailId: mailResult.mailId ?? null,
    };
};

const recheckExecutablePartner = async (partnerId: number): Promise<TargetPartnerRow | null> => {
    const result = await query<TargetPartnerRow>(
        `
      SELECT
        cp.id AS partner_id,
        cp.partner_def_id,
        cp.nickname AS partner_nickname,
        cp.level AS partner_level,
        cp.progress_exp AS partner_progress_exp,
        cp.is_active AS partner_is_active,
        cp.created_at AS partner_created_at,
        c.user_id AS owner_user_id,
        c.id AS owner_character_id,
        c.nickname AS owner_nickname,
        prj.id AS recruit_job_id,
        prj.requested_base_model,
        prj.created_at AS recruit_created_at,
        mpl.id AS active_market_listing_id,
        pfj.fusion_job_id AS active_fusion_job_id,
        pfj.status AS active_fusion_status
      FROM character_partner cp
      JOIN partner_recruit_job prj
        ON cp.obtained_from = 'partner_recruit'
       AND cp.obtained_ref_id = prj.id
      JOIN characters c
        ON c.id = cp.character_id
      LEFT JOIN LATERAL (
        SELECT id
        FROM market_partner_listing
        WHERE partner_id = cp.id
          AND status = 'active'
        ORDER BY id DESC
        LIMIT 1
      ) mpl ON TRUE
      LEFT JOIN LATERAL (
        SELECT j.id AS fusion_job_id, j.status
        FROM partner_fusion_job_material m
        JOIN partner_fusion_job j
          ON j.id = m.fusion_job_id
        WHERE m.partner_id = cp.id
          AND j.status = ANY($2::text[])
        ORDER BY j.created_at DESC
        LIMIT 1
      ) pfj ON TRUE
      WHERE cp.id = $1
      ${RECHECK_EXECUTABLE_PARTNER_LOCK_SQL}
    `,
        [partnerId, ACTIVE_FUSION_JOB_STATUSES],
    );
    return result.rows[0] ?? null;
};

const executeReclaim = async (
    report: ReclaimReport,
    backupFilePath: string,
): Promise<PartnerExecutionResult[]> => {
    const compensationItemName = report.compensationItemName;
    const executionResults: PartnerExecutionResult[] = [];

    for (const partner of report.partners) {
        if (!partner.reclaimable) {
            executionResults.push({
                partnerId: partner.partnerId,
                generationId: partner.generationId,
                ownerCharacterId: partner.ownerCharacterId,
                mode: 'execute',
                status: 'skipped',
                compensationItemDefId: COMPENSATION_ITEM_DEF_ID,
                compensationItemName,
                compensationQty: COMPENSATION_ITEM_QTY,
                rewardDelivery: null,
                rewardMailId: null,
                message: `跳过：${partner.blockedReasons.join('；')}`,
            });
            continue;
        }

        const executionResult = await withTransaction(async (): Promise<PartnerExecutionResult> => {
            const lockedRow = await recheckExecutablePartner(partner.partnerId);
            if (!lockedRow) {
                return {
                    partnerId: partner.partnerId,
                    generationId: partner.generationId,
                    ownerCharacterId: partner.ownerCharacterId,
                    mode: 'execute',
                    status: 'skipped',
                    compensationItemDefId: COMPENSATION_ITEM_DEF_ID,
                    compensationItemName,
                    compensationQty: COMPENSATION_ITEM_QTY,
                    rewardDelivery: null,
                    rewardMailId: null,
                    message: '跳过：伙伴已不存在或已不再属于招募来源',
                };
            }

            const blockedReasons = buildBlockedReasons(lockedRow);
            if (blockedReasons.length > 0) {
                return {
                    partnerId: partner.partnerId,
                    generationId: partner.generationId,
                    ownerCharacterId: partner.ownerCharacterId,
                    mode: 'execute',
                    status: 'skipped',
                    compensationItemDefId: COMPENSATION_ITEM_DEF_ID,
                    compensationItemName,
                    compensationQty: COMPENSATION_ITEM_QTY,
                    rewardDelivery: null,
                    rewardMailId: null,
                    message: `跳过：${blockedReasons.join('；')}`,
                };
            }

            if (lockedRow.active_market_listing_id !== null) {
                const cancelListingResult = await cancelActivePartnerMarketListing({
                    listingId: lockedRow.active_market_listing_id,
                    expectedSellerCharacterId: lockedRow.owner_character_id,
                });
                if (!cancelListingResult.success) {
                    throw new Error(`强制下架伙伴挂单失败：${cancelListingResult.message}`);
                }
            }

            const rewardMailResult = await sendPartnerReclaimRewardMail({
                partner,
                ownerUserId: lockedRow.owner_user_id,
                ownerCharacterId: lockedRow.owner_character_id,
                generationId: normalizeText(lockedRow.recruit_job_id),
            });
            if (!rewardMailResult.success || rewardMailResult.mailId === null) {
                throw new Error(`发送回收返还邮件失败：${rewardMailResult.message}`);
            }

            const backupPayload = await loadPartnerBackupPayload({
                partnerId: lockedRow.partner_id,
                generationId: normalizeText(lockedRow.recruit_job_id),
                baseModel: normalizeText(lockedRow.requested_base_model),
                ownerCharacterId: lockedRow.owner_character_id,
                ownerUserId: lockedRow.owner_user_id,
                compensationItemName,
            });
            await appendBackupPayload(backupFilePath, backupPayload);

            const deleteResult = await query<{ id: number }>(
                `
          DELETE FROM character_partner
          WHERE id = $1
            AND character_id = $2
          RETURNING id
        `,
                [lockedRow.partner_id, lockedRow.owner_character_id],
            );
            if ((deleteResult.rowCount ?? 0) <= 0) {
                throw new Error('删除伙伴失败：目标行不存在');
            }

            return {
                partnerId: lockedRow.partner_id,
                generationId: normalizeText(lockedRow.recruit_job_id),
                ownerCharacterId: lockedRow.owner_character_id,
                mode: 'execute',
                status: 'executed',
                compensationItemDefId: COMPENSATION_ITEM_DEF_ID,
                compensationItemName,
                compensationQty: COMPENSATION_ITEM_QTY,
                rewardDelivery: 'mail',
                rewardMailId: rewardMailResult.mailId,
                message: `已回收伙伴，并发送返还邮件 #${rewardMailResult.mailId}`,
            };
        });

        executionResults.push(executionResult);
        if (executionResult.status === 'executed') {
            await invalidateCharacterComputedCache(executionResult.ownerCharacterId);
            await scheduleActivePartnerBattleCacheRefreshByCharacterId(executionResult.ownerCharacterId);
        }
    }

    return executionResults;
};

const ensureCompensationItemConfigured = (): void => {
    const itemDef = getItemDefinitionById(COMPENSATION_ITEM_DEF_ID);
    if (!itemDef) {
        throw new Error(`补偿道具不存在：${COMPENSATION_ITEM_DEF_ID}`);
    }
};

const main = async (): Promise<void> => {
    ensureCompensationItemConfigured();
    const options = parseCliOptions(process.argv.slice(2));
    const targetSelector = options.partnerIds.length > 0
        ? buildPartnerReclaimTargetSelector({
            baseModels: [],
            recruitJobIds: [],
            partnerIds: options.partnerIds,
        })
        : options.recruitJobIds.length > 0
            ? buildPartnerReclaimTargetSelector({
                baseModels: [],
                recruitJobIds: options.recruitJobIds,
                partnerIds: [],
            })
            : loadConfiguredTargetSelector();
    const backupFilePath = options.mode === 'execute' ? buildDefaultBackupFilePath() : null;
    if (backupFilePath) {
        await ensureParentDirectory(backupFilePath);
        await fs.writeFile(backupFilePath, '', { flag: 'a' });
    }
    const report = await buildReport({
        mode: options.mode,
        targetSelector,
        backupFilePath,
    });

    printReportSummary(report);

    if (options.mode === 'execute') {
        console.log('\n开始执行回收...');
        if (!backupFilePath) {
            throw new Error('执行模式缺少备份文件路径，已中止删除');
        }
        report.executionResults = await executeReclaim(report, backupFilePath);
        for (const executionResult of report.executionResults) {
            console.log(`- [${executionResult.status}] 伙伴 #${executionResult.partnerId}: ${executionResult.message}`);
        }
    }

    if (options.reportFilePath) {
        await writeReportFile(options.reportFilePath, report);
        console.log(`\n报告已写入：${resolveFilePath(options.reportFilePath)}`);
    }
};

void main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : '伙伴回收脚本执行失败');
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
