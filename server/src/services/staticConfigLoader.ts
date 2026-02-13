import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEEDS_DIR = [
  path.join(process.cwd(), 'src', 'data', 'seeds'),
  path.join(process.cwd(), 'dist', 'data', 'seeds'),
  path.join(__dirname, '../data/seeds'),
].find((p) => fs.existsSync(p)) ?? path.join(__dirname, '../data/seeds');

const readJsonFile = <T>(filename: string): T | null => {
  try {
    const filePath = path.join(SEEDS_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
};

export type BattlePassRewardEntry =
  | { type: 'item'; item_def_id: string; qty: number }
  | { type: 'currency'; currency: 'spirit_stones' | 'silver'; amount: number };

export type BattlePassSeasonConfig = {
  id: string;
  name: string;
  start_at: string;
  end_at: string;
  max_level: number;
  exp_per_level: number;
  enabled: boolean;
  sort_weight: number;
};

export type BattlePassTaskConfig = {
  id: string;
  code: string;
  name: string;
  description?: string;
  task_type: 'daily' | 'weekly' | 'season';
  condition: { event: string; params?: Record<string, unknown> };
  target_value: number;
  reward_exp: number;
  reward_extra?: BattlePassRewardEntry[];
  enabled?: boolean;
  sort_weight?: number;
};

type BattlePassRewardFile = {
  season: {
    id: string;
    name: string;
    start_at: string;
    end_at: string;
    max_level?: number;
    exp_per_level?: number;
    enabled?: boolean;
    sort_weight?: number;
  };
  rewards: Array<{ level: number; free?: BattlePassRewardEntry[]; premium?: BattlePassRewardEntry[] }>;
};

type BattlePassTaskFile = {
  season_id: string;
  tasks: BattlePassTaskConfig[];
};

export type BattlePassStaticConfig = {
  season: BattlePassSeasonConfig;
  rewards: Array<{ level: number; free: BattlePassRewardEntry[]; premium: BattlePassRewardEntry[] }>;
  tasks: BattlePassTaskConfig[];
};

type MonthCardDef = {
  id: string;
  code?: string;
  name: string;
  description?: string;
  duration_days?: number;
  daily_spirit_stones?: number;
  price_spirit_stones?: number | string;
  enabled?: boolean;
  sort_weight?: number;
};

type MonthCardFile = { month_cards: MonthCardDef[] };

export type AchievementRewardEntry =
  | { type: 'item'; item_def_id: string; qty?: number }
  | { type: 'silver' | 'spirit_stones' | 'exp'; amount: number }
  | Record<string, unknown>;

export type AchievementDefConfig = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  rarity?: string;
  points?: number;
  icon?: string;
  hidden?: boolean;
  prerequisite_id?: string | null;
  track_type?: 'counter' | 'flag' | 'multi';
  track_key: string;
  target_value?: number;
  target_list?: unknown[];
  rewards?: AchievementRewardEntry[];
  title_id?: string | null;
  sort_weight?: number;
  enabled?: boolean;
  version?: number;
};

export type TitleDefConfig = {
  id: string;
  name: string;
  description?: string;
  rarity?: string;
  color?: string;
  icon?: string;
  effects?: Record<string, unknown>;
  source_type?: string;
  source_id?: string;
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

export type AchievementPointsRewardConfig = {
  id: string;
  points_threshold: number;
  name: string;
  description?: string;
  rewards?: AchievementRewardEntry[];
  title_id?: string | null;
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

type AchievementDefFile = { achievements: AchievementDefConfig[] };
type TitleDefFile = { titles: TitleDefConfig[] };
type AchievementPointsRewardFile = { rewards: AchievementPointsRewardConfig[] };

export type NpcDefConfig = {
  id: string;
  code?: string;
  name: string;
  title?: string;
  gender?: string;
  realm?: string;
  avatar?: string;
  description?: string;
  npc_type?: string;
  area?: string;
  talk_tree_id?: string;
  shop_id?: string;
  quest_giver_id?: string;
  drop_pool_id?: string;
  base_attrs?: Record<string, unknown>;
  enabled?: boolean;
  sort_weight?: number;
};

export type TalkTreeDefConfig = {
  id: string;
  name: string;
  greeting_lines?: string[];
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

export type MapDefConfig = {
  id: string;
  code?: string;
  name: string;
  description?: string;
  background_image?: string;
  map_type?: string;
  parent_map_id?: string;
  world_position?: unknown;
  region?: string;
  req_realm_min?: string | null;
  req_level_min?: number;
  req_quest_id?: string | null;
  req_item_id?: string | null;
  safe_zone?: boolean;
  pk_mode?: string;
  revive_map_id?: string | null;
  revive_room_id?: string | null;
  rooms?: unknown;
  sort_weight?: number;
  enabled?: boolean;
};

export type MonsterDefConfig = {
  id: string;
  code?: string;
  name: string;
  title?: string;
  realm?: string;
  level?: number;
  avatar?: string;
  kind?: string;
  element?: string;
  base_attrs?: Record<string, unknown>;
  attr_variance?: number;
  attr_multiplier_min?: number;
  attr_multiplier_max?: number;
  display_stats?: unknown[];
  ai_profile?: Record<string, unknown>;
  drop_pool_id?: string;
  exp_reward?: number;
  silver_reward_min?: number;
  silver_reward_max?: number;
  enabled?: boolean;
};

export type SpawnRuleConfig = {
  id: string;
  area: string;
  pool_type?: string;
  pool_entries?: Array<{ monster_def_id?: string; npc_def_id?: string; weight?: number }>;
  max_alive?: number;
  respawn_sec?: number;
  elite_chance?: number;
  boss_window?: Record<string, unknown>;
  req_realm_min?: string;
  req_quest_id?: string;
  enabled?: boolean;
};

type NpcDefFile = { npcs: NpcDefConfig[]; talk_trees?: TalkTreeDefConfig[] };
type MapDefFile = { maps: MapDefConfig[] };
type MonsterDefFile = { monsters: MonsterDefConfig[] };
type SpawnRuleFile = { rules: SpawnRuleConfig[] };

export type BountyDefConfig = {
  id: string;
  pool?: string;
  task_id: string;
  title: string;
  description?: string | null;
  claim_policy?: string;
  max_claims?: number;
  weight?: number;
  enabled?: boolean;
  version?: number;
};

export type DungeonDefConfig = {
  id: string;
  name: string;
  type: string;
  category?: string | null;
  description?: string | null;
  icon?: string | null;
  background?: string | null;
  min_players?: number;
  max_players?: number;
  min_realm?: string | null;
  recommended_realm?: string | null;
  unlock_condition?: unknown;
  daily_limit?: number;
  weekly_limit?: number;
  stamina_cost?: number;
  time_limit_sec?: number;
  revive_limit?: number;
  tags?: unknown;
  sort_weight?: number;
  enabled?: boolean;
  version?: number;
};

export type DialogueDefConfig = {
  id: string;
  name: string;
  nodes?: unknown[];
  enabled?: boolean;
};

type BountyDefFile = { bounties: BountyDefConfig[] };
type DungeonSeedFile = {
  dungeons?: Array<{
    def?: DungeonDefConfig;
  }>;
};
type DialogueFile = { dialogues: DialogueDefConfig[] };

export type TechniqueDefConfig = {
  id: string;
  code?: string;
  name: string;
  type: string;
  quality: string;
  quality_rank?: number;
  max_layer?: number;
  required_realm?: string;
  attribute_type?: string;
  attribute_element?: string;
  tags?: string[];
  description?: string | null;
  long_desc?: string | null;
  icon?: string | null;
  obtain_type?: string | null;
  obtain_hint?: string[];
  sort_weight?: number;
  version?: number;
  enabled?: boolean;
};

export type SkillDefConfig = {
  id: string;
  code?: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  source_type: string;
  source_id?: string | null;
  cost_lingqi?: number;
  cost_qixue?: number;
  cooldown?: number;
  target_type: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: unknown[];
  trigger_type?: string;
  conditions?: unknown;
  ai_priority?: number;
  ai_conditions?: unknown;
  upgrades?: unknown;
  sort_weight?: number;
  version?: number;
  enabled?: boolean;
};

export type TaskDefConfig = {
  id: string;
  category: string;
  title: string;
  realm: string;
  description?: string;
  giver_npc_id?: string;
  map_id?: string;
  room_id?: string;
  objectives?: Array<{
    id: string;
    type: string;
    text: string;
    target: number;
    params?: Record<string, unknown>;
  }>;
  rewards?: Array<{
    type: string;
    item_def_id?: string;
    qty?: number;
    qty_min?: number;
    qty_max?: number;
    amount?: number;
  }>;
  prereq_task_ids?: string[];
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

type TechniqueDefFile = { techniques: TechniqueDefConfig[] };
type SkillDefFile = { skills: SkillDefConfig[] };
type TaskDefFile = { tasks: TaskDefConfig[] };

export type DropPoolEntryConfig = {
  item_def_id: string;
  chance?: number;
  weight?: number;
  qty_min?: number;
  qty_max?: number;
  quality_weights?: Record<string, unknown> | null;
  bind_type?: string;
  show_in_ui?: boolean;
  sort_order?: number;
};

export type DropPoolDefConfig = {
  id: string;
  name: string;
  description?: string;
  mode?: 'prob' | 'weight';
  entries?: DropPoolEntryConfig[];
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

type DropPoolFile = {
  pools: DropPoolDefConfig[];
};

export type AffixTierConfig = {
  tier: number;
  min: number;
  max: number;
  realm_rank_min: number;
  description?: string;
};

export type AffixDefConfig = {
  key: string;
  name: string;
  attr_key: string;
  apply_type: 'flat' | 'percent' | 'special';
  group: string;
  weight: number;
  is_legendary?: boolean;
  trigger?: 'on_turn_start' | 'on_skill' | 'on_hit' | 'on_crit' | 'on_be_hit' | 'on_heal';
  target?: 'self' | 'enemy';
  effect_type?: 'buff' | 'debuff' | 'damage' | 'heal' | 'resource';
  duration_round?: number;
  params?: Record<string, string | number | boolean>;
  tiers: AffixTierConfig[];
};

export type AffixPoolRulesConfig = {
  count_by_quality?: Record<string, { min: number; max: number }>;
  allow_duplicate?: boolean;
  mutex_groups?: string[][];
  max_per_group?: Record<string, number>;
  legendary_chance?: number;
};

export type AffixPoolDefConfig = {
  id: string;
  name: string;
  description?: string;
  rules: AffixPoolRulesConfig;
  affixes: AffixDefConfig[];
  enabled?: boolean;
  version?: number;
};

type AffixPoolFile = {
  pools: AffixPoolDefConfig[];
};

export type ItemSetPieceConfig = {
  equip_slot: string;
  item_def_id: string;
  piece_key: string;
};

export type ItemSetBonusConfig = {
  piece_count: number;
  effect_defs: unknown[];
  priority?: number;
};

export type ItemSetDefConfig = {
  id: string;
  name: string;
  description?: string;
  quality_rank?: number;
  min_realm?: string;
  pieces?: ItemSetPieceConfig[];
  bonuses?: ItemSetBonusConfig[];
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

type ItemSetFile = {
  sets: ItemSetDefConfig[];
};

export type TechniqueLayerCostMaterialConfig = {
  itemId: string;
  qty: number;
};

export type TechniqueLayerPassiveConfig = {
  key: string;
  value: number;
};

export type TechniqueLayerConfig = {
  technique_id: string;
  layer: number;
  cost_spirit_stones?: number;
  cost_exp?: number;
  cost_materials?: TechniqueLayerCostMaterialConfig[];
  passives?: TechniqueLayerPassiveConfig[];
  unlock_skill_ids?: string[];
  upgrade_skill_ids?: string[];
  required_realm?: string | null;
  required_quest_id?: string | null;
  layer_desc?: string | null;
  enabled?: boolean;
};

type TechniqueLayerFile = {
  layers: TechniqueLayerConfig[];
};

let battlePassCache: BattlePassStaticConfig | null | undefined;
let monthCardCache: MonthCardDef[] | null | undefined;
let achievementDefCache: AchievementDefConfig[] | null | undefined;
let titleDefCache: TitleDefConfig[] | null | undefined;
let achievementPointsRewardCache: AchievementPointsRewardConfig[] | null | undefined;
let npcDefCache: NpcDefConfig[] | null | undefined;
let talkTreeDefCache: TalkTreeDefConfig[] | null | undefined;
let mapDefCache: MapDefConfig[] | null | undefined;
let monsterDefCache: MonsterDefConfig[] | null | undefined;
let spawnRuleCache: SpawnRuleConfig[] | null | undefined;
let bountyDefCache: BountyDefConfig[] | null | undefined;
let dungeonDefCache: DungeonDefConfig[] | null | undefined;
let dialogueDefCache: DialogueDefConfig[] | null | undefined;
let techniqueDefCache: TechniqueDefConfig[] | null | undefined;
let skillDefCache: SkillDefConfig[] | null | undefined;
let taskDefCache: TaskDefConfig[] | null | undefined;
let dropPoolDefCache: DropPoolDefConfig[] | null | undefined;
let affixPoolDefCache: AffixPoolDefConfig[] | null | undefined;
let itemSetDefCache: ItemSetDefConfig[] | null | undefined;
let techniqueLayerCache: TechniqueLayerConfig[] | null | undefined;

export const getBattlePassStaticConfig = (): BattlePassStaticConfig | null => {
  if (battlePassCache !== undefined) return battlePassCache;

  const rewardFile = readJsonFile<BattlePassRewardFile>('battle_pass_rewards.json');
  const taskFile = readJsonFile<BattlePassTaskFile>('battle_pass_tasks.json');
  if (!rewardFile?.season?.id || !Array.isArray(rewardFile.rewards) || !taskFile?.season_id || !Array.isArray(taskFile.tasks)) {
    battlePassCache = null;
    return battlePassCache;
  }

  const season: BattlePassSeasonConfig = {
    id: String(rewardFile.season.id),
    name: String(rewardFile.season.name || ''),
    start_at: String(rewardFile.season.start_at),
    end_at: String(rewardFile.season.end_at),
    max_level: Number.isFinite(Number(rewardFile.season.max_level)) ? Number(rewardFile.season.max_level) : 30,
    exp_per_level: Number.isFinite(Number(rewardFile.season.exp_per_level)) ? Number(rewardFile.season.exp_per_level) : 1000,
    enabled: rewardFile.season.enabled !== false,
    sort_weight: Number.isFinite(Number(rewardFile.season.sort_weight)) ? Number(rewardFile.season.sort_weight) : 0,
  };

  const rewards = rewardFile.rewards
    .map((entry) => ({
      level: Number(entry.level),
      free: Array.isArray(entry.free) ? entry.free : [],
      premium: Array.isArray(entry.premium) ? entry.premium : [],
    }))
    .filter((entry) => Number.isFinite(entry.level) && entry.level > 0)
    .sort((a, b) => a.level - b.level);

  if (String(taskFile.season_id) !== season.id) {
    battlePassCache = null;
    return battlePassCache;
  }

  const tasks = taskFile.tasks;

  battlePassCache = {
    season,
    rewards,
    tasks,
  };
  return battlePassCache;
};

export const getMonthCardDefinitions = (): MonthCardDef[] => {
  if (monthCardCache !== undefined) return monthCardCache ?? [];
  const file = readJsonFile<MonthCardFile>('month_card.json');
  monthCardCache = Array.isArray(file?.month_cards) ? file.month_cards : [];
  return monthCardCache;
};

export const getAchievementDefinitions = (): AchievementDefConfig[] => {
  if (achievementDefCache !== undefined) return achievementDefCache ?? [];
  const file = readJsonFile<AchievementDefFile>('achievement_def.json');
  achievementDefCache = Array.isArray(file?.achievements) ? file.achievements : [];
  return achievementDefCache;
};

export const getTitleDefinitions = (): TitleDefConfig[] => {
  if (titleDefCache !== undefined) return titleDefCache ?? [];
  const file = readJsonFile<TitleDefFile>('title_def.json');
  titleDefCache = Array.isArray(file?.titles) ? file.titles : [];
  return titleDefCache;
};

export const getAchievementPointsRewardDefinitions = (): AchievementPointsRewardConfig[] => {
  if (achievementPointsRewardCache !== undefined) return achievementPointsRewardCache ?? [];
  const file = readJsonFile<AchievementPointsRewardFile>('achievement_points_rewards.json');
  achievementPointsRewardCache = Array.isArray(file?.rewards) ? file.rewards : [];
  return achievementPointsRewardCache;
};

export const getNpcDefinitions = (): NpcDefConfig[] => {
  if (npcDefCache !== undefined) return npcDefCache ?? [];
  const file = readJsonFile<NpcDefFile>('npc_def.json');
  npcDefCache = Array.isArray(file?.npcs) ? file.npcs : [];
  return npcDefCache;
};

export const getTalkTreeDefinitions = (): TalkTreeDefConfig[] => {
  if (talkTreeDefCache !== undefined) return talkTreeDefCache ?? [];
  const file = readJsonFile<NpcDefFile>('npc_def.json');
  talkTreeDefCache = Array.isArray(file?.talk_trees) ? file.talk_trees : [];
  return talkTreeDefCache;
};

export const getMapDefinitions = (): MapDefConfig[] => {
  if (mapDefCache !== undefined) return mapDefCache ?? [];
  const file = readJsonFile<MapDefFile>('map_def.json');
  mapDefCache = Array.isArray(file?.maps) ? file.maps : [];
  return mapDefCache;
};

export const getMonsterDefinitions = (): MonsterDefConfig[] => {
  if (monsterDefCache !== undefined) return monsterDefCache ?? [];
  const file = readJsonFile<MonsterDefFile>('monster_def.json');
  monsterDefCache = Array.isArray(file?.monsters) ? file.monsters : [];
  return monsterDefCache;
};

export const getSpawnRuleDefinitions = (): SpawnRuleConfig[] => {
  if (spawnRuleCache !== undefined) return spawnRuleCache ?? [];
  const file = readJsonFile<SpawnRuleFile>('spawn_rule.json');
  spawnRuleCache = Array.isArray(file?.rules) ? file.rules : [];
  return spawnRuleCache;
};

export const getBountyDefinitions = (): BountyDefConfig[] => {
  if (bountyDefCache !== undefined) return bountyDefCache ?? [];
  const file = readJsonFile<BountyDefFile>('bounty_def.json');
  bountyDefCache = Array.isArray(file?.bounties) ? file.bounties : [];
  return bountyDefCache;
};

export const getDungeonDefinitions = (): DungeonDefConfig[] => {
  if (dungeonDefCache !== undefined) return dungeonDefCache ?? [];

  const files = fs.existsSync(SEEDS_DIR)
    ? fs
        .readdirSync(SEEDS_DIR)
        .filter((filename) => /^dungeon_.*\.json$/i.test(filename))
        .sort((left, right) => left.localeCompare(right))
    : [];

  const dungeons: DungeonDefConfig[] = [];
  for (const filename of files) {
    const file = readJsonFile<DungeonSeedFile>(filename);
    const list = Array.isArray(file?.dungeons) ? file.dungeons : [];
    for (const entry of list) {
      if (!entry?.def?.id) continue;
      dungeons.push(entry.def);
    }
  }

  dungeonDefCache = dungeons;
  return dungeonDefCache;
};

export const getDialogueDefinitions = (): DialogueDefConfig[] => {
  if (dialogueDefCache !== undefined) return dialogueDefCache ?? [];

  const files = fs.existsSync(SEEDS_DIR)
    ? fs
        .readdirSync(SEEDS_DIR)
        .filter((filename) => /^dialogue_main_chapter\d+\.json$/i.test(filename))
        .sort((left, right) => left.localeCompare(right))
    : [];

  const dialogues: DialogueDefConfig[] = [];
  for (const filename of files) {
    const file = readJsonFile<DialogueFile>(filename);
    if (!Array.isArray(file?.dialogues)) continue;
    dialogues.push(...file.dialogues);
  }

  dialogueDefCache = dialogues;
  return dialogueDefCache;
};

export const getTechniqueDefinitions = (): TechniqueDefConfig[] => {
  if (techniqueDefCache !== undefined) return techniqueDefCache ?? [];
  const file = readJsonFile<TechniqueDefFile>('technique_def.json');
  techniqueDefCache = Array.isArray(file?.techniques) ? file.techniques : [];
  return techniqueDefCache;
};

export const getSkillDefinitions = (): SkillDefConfig[] => {
  if (skillDefCache !== undefined) return skillDefCache ?? [];
  const file = readJsonFile<SkillDefFile>('skill_def.json');
  skillDefCache = Array.isArray(file?.skills) ? file.skills : [];
  return skillDefCache;
};

export const getTaskDefinitions = (): TaskDefConfig[] => {
  if (taskDefCache !== undefined) return taskDefCache ?? [];
  const file = readJsonFile<TaskDefFile>('task_def.json');
  taskDefCache = Array.isArray(file?.tasks) ? file.tasks : [];
  return taskDefCache;
};

export const getDropPoolDefinitions = (): DropPoolDefConfig[] => {
  if (dropPoolDefCache !== undefined) return dropPoolDefCache ?? [];
  const file = readJsonFile<DropPoolFile>('drop_pool.json');
  dropPoolDefCache = Array.isArray(file?.pools) ? file.pools : [];
  return dropPoolDefCache;
};

export const getAffixPoolDefinitions = (): AffixPoolDefConfig[] => {
  if (affixPoolDefCache !== undefined) return affixPoolDefCache ?? [];
  const file = readJsonFile<AffixPoolFile>('affix_pool.json');
  affixPoolDefCache = Array.isArray(file?.pools) ? file.pools : [];
  return affixPoolDefCache;
};

export const getItemSetDefinitions = (): ItemSetDefConfig[] => {
  if (itemSetDefCache !== undefined) return itemSetDefCache ?? [];
  const file = readJsonFile<ItemSetFile>('item_set.json');
  itemSetDefCache = Array.isArray(file?.sets) ? file.sets : [];
  return itemSetDefCache;
};

export const getTechniqueLayerDefinitions = (): TechniqueLayerConfig[] => {
  if (techniqueLayerCache !== undefined) return techniqueLayerCache ?? [];
  const file = readJsonFile<TechniqueLayerFile>('technique_layer.json');
  techniqueLayerCache = Array.isArray(file?.layers) ? file.layers : [];
  return techniqueLayerCache;
};
