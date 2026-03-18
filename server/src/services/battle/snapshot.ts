/**
 * 角色战斗快照构建
 *
 * 作用：将角色属性、技能、套装效果打包为 IdleSession 所需的战斗快照。
 *
 * 输入/输出：
 * - buildCharacterBattleSnapshot: characterId -> snapshot | null
 *
 * 复用点：idleSessionService.ts 在 startIdleSession 时调用。
 *
 * 边界条件：
 * 1) 快照一次性生成，后续战斗均使用此快照，不随角色实时属性变化
 * 2) setBonusEffects 包含套装效果和词缀效果
 */

import type {
  BattleAttrs,
  BattleSkill,
  BattleSetBonusEffect,
} from "../../battle/types.js";
import type { CharacterData } from "../../battle/battleFactory.js";
import {
  getCharacterComputedByCharacterId,
} from "../characterComputedService.js";
import { normalizeRealmKeepingUnknown } from "../shared/realmRules.js";
import { getCharacterBattleLoadoutByCharacterId } from "./shared/profileCache.js";
import { toBattleSkill } from "./shared/skills.js";

export async function buildCharacterBattleSnapshot(
  characterId: number,
): Promise<{
  baseAttrs: BattleAttrs;
  skills: BattleSkill[];
  setBonusEffects: BattleSetBonusEffect[];
  realm: string;
  nickname: string;
} | null> {
  const base = await getCharacterComputedByCharacterId(characterId);
  if (!base) return null;

  const battleLoadout = await getCharacterBattleLoadoutByCharacterId(characterId);
  if (!battleLoadout) return null;
  const characterData: CharacterData = {
    ...base,
    setBonusEffects: battleLoadout.setBonusEffects,
  };

  const baseAttrs: BattleAttrs = {
    max_qixue: characterData.max_qixue,
    max_lingqi: characterData.max_lingqi,
    wugong: characterData.wugong,
    fagong: characterData.fagong,
    wufang: characterData.wufang,
    fafang: characterData.fafang,
    sudu: characterData.sudu,
    mingzhong: characterData.mingzhong,
    shanbi: characterData.shanbi,
    zhaojia: characterData.zhaojia,
    baoji: characterData.baoji,
    baoshang: characterData.baoshang,
    jianbaoshang: characterData.jianbaoshang,
    jianfantan: characterData.jianfantan,
    kangbao: characterData.kangbao,
    zengshang: characterData.zengshang,
    zhiliao: characterData.zhiliao,
    jianliao: characterData.jianliao,
    xixue: characterData.xixue,
    lengque: characterData.lengque,
    kongzhi_kangxing: characterData.kongzhi_kangxing,
    jin_kangxing: characterData.jin_kangxing,
    mu_kangxing: characterData.mu_kangxing,
    shui_kangxing: characterData.shui_kangxing,
    huo_kangxing: characterData.huo_kangxing,
    tu_kangxing: characterData.tu_kangxing,
    qixue_huifu: characterData.qixue_huifu,
    lingqi_huifu: characterData.lingqi_huifu,
    realm: normalizeRealmKeepingUnknown(characterData.realm, null),
    element: characterData.attribute_element,
  };

  const skills: BattleSkill[] = battleLoadout.skills.map((data) => toBattleSkill(data));

  return {
    baseAttrs,
    skills,
    setBonusEffects: characterData.setBonusEffects ?? [],
    realm: String(characterData.realm || "凡人"),
    nickname: String(characterData.nickname || "无名修士"),
  };
}
