/**
 * 伙伴招募阶段进度模型
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义伙伴招募异步生成过程的阶段顺序、玩家可见文案与进度数值。
 * 2. 做什么：把后端写库阶段与前端展示 DTO 收敛为单一入口，避免 service、状态构建器和页面各自维护阶段映射。
 * 3. 不做什么：不查询数据库、不推进任务状态，也不暴露模型、worker、DTO 等技术实现细节给玩家。
 *
 * 输入/输出：
 * - 输入：当前招募阶段、阶段更新时间，以及任务是否已经完成。
 * - 输出：前端可直接展示的阶段名、说明、完成阶段数、剩余阶段数与百分比。
 *
 * 数据流/状态流：
 * partnerRecruitService 写入 progress_stage -> buildPartnerRecruitJobState 构建 progress -> 状态接口 / WebSocket -> PartnerModal 展示。
 *
 * 复用设计说明：
 * 1. 阶段顺序、文案和百分比只在本模块维护，后续招募状态接口、红点推送或其他伙伴招募入口都复用同一套规则。
 * 2. “形象与功法”阶段表达为并行塑造，贴合现有并发生成实现，避免页面和后端对同一业务过程产生两套口径。
 * 3. 阶段文案属于高频业务调整点，集中后可直接按玩家反馈统一优化用词。
 *
 * 关键边界条件与坑点：
 * 1. 当前阶段不等于已完成阶段；进行到第 N 阶段时，只能把前 N-1 阶段计入完成，避免玩家误以为当前步骤已经结束。
 * 2. 头像与天生功法在生成逻辑中是并发执行，不应拆成串行阶段文案，否则会误导玩家对等待原因的理解。
 */
export type PartnerRecruitProgressStage =
    | 'queued'
    | 'reviewing_base_model'
    | 'summoning_partner_spirit'
    | 'shaping_appearance_and_techniques'
    | 'preparing_preview';

export type PartnerRecruitProgressDto = {
    stage: PartnerRecruitProgressStage;
    label: string;
    description: string;
    completedStages: number;
    totalStages: number;
    remainingStages: number;
    percent: number;
    updatedAt: string | null;
};

type PartnerRecruitProgressStageInfo = {
    stage: PartnerRecruitProgressStage;
    label: string;
    description: string;
};

export const PARTNER_RECRUIT_INITIAL_PROGRESS_STAGE: PartnerRecruitProgressStage = 'queued';

const PARTNER_RECRUIT_COMPLETED_LABEL = '招募预览已备好';
const PARTNER_RECRUIT_COMPLETED_DESCRIPTION = '新的伙伴预览已经整理完成，请查看后决定是否邀请入队。';

const PARTNER_RECRUIT_PROGRESS_STAGE_INFOS: readonly PartnerRecruitProgressStageInfo[] = [
    {
        stage: 'queued',
        label: '正在准备招募任务',
        description: '招募已开始，正在为本次伙伴生成做准备。',
    },
    {
        stage: 'reviewing_base_model',
        label: '正在确认招募方向',
        description: '正在确认你填写的指定底模或随机方向，确保本次生成可以顺利展开。',
    },
    {
        stage: 'summoning_partner_spirit',
        label: '正在生成伙伴属性与设定',
        description: '正在生成伙伴的品级、五行、定位、基础属性与成长方向。',
    },
    {
        stage: 'shaping_appearance_and_techniques',
        label: '正在生成伙伴头像与天生功法',
        description: '正在同步生成伙伴头像、天生功法与技能信息，这一步可能需要多等片刻。',
    },
    {
        stage: 'preparing_preview',
        label: '正在整理伙伴预览',
        description: '正在整理伙伴头像、属性、说明和功法预览，马上就能查看本次招募结果。',
    },
];

const PARTNER_RECRUIT_PROGRESS_STAGE_BY_STAGE = new Map(
    PARTNER_RECRUIT_PROGRESS_STAGE_INFOS.map((entry, index) => [entry.stage, { ...entry, index }]),
);

export const buildPartnerRecruitProgress = (params: {
    stage: PartnerRecruitProgressStage;
    updatedAt: string | null;
    completed: boolean;
}): PartnerRecruitProgressDto => {
    const stageInfo = PARTNER_RECRUIT_PROGRESS_STAGE_BY_STAGE.get(params.stage);
    if (!stageInfo) {
        throw new Error(`未知伙伴招募进度阶段：${params.stage}`);
    }

    const totalStages = PARTNER_RECRUIT_PROGRESS_STAGE_INFOS.length;
    const completedStages = params.completed ? totalStages : stageInfo.index;
    const remainingStages = Math.max(0, totalStages - completedStages);

    return {
        stage: params.stage,
        label: params.completed ? PARTNER_RECRUIT_COMPLETED_LABEL : stageInfo.label,
        description: params.completed ? PARTNER_RECRUIT_COMPLETED_DESCRIPTION : stageInfo.description,
        completedStages,
        totalStages,
        remainingStages,
        percent: Math.round((completedStages / totalStages) * 100),
        updatedAt: params.updatedAt,
    };
};
