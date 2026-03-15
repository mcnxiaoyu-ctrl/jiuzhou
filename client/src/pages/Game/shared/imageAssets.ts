/**
 * 静态图片资源路径常量
 *
 * 作用：
 * - 集中管理所有 UI / 地图等固定图片的路径
 * - 公共资源统一从这里导出，避免业务组件各自维护图片路径
 * - `public/assets` 下的静态资源通过 resolveAssetUrl 解析，自动适配 CDN（VITE_CDN_BASE）
 * - `src/assets` 下的构建资源通过 ESM import 导出，交由前端构建流程处理
 *
 * 数据流：
 *   资源路径常量 / ESM import → 业务组件引用 → 浏览器请求静态资源
 *
 * 边界条件：
 * - `public/assets` 资源路径必须与此处声明一致
 * - `src/assets` 资源必须通过 import 引入，避免业务组件直接散写路径
 *
 * 复用点：
 * - Auth/index.tsx, Game/index.tsx, MapModal, TaskModal, TechniqueModal,
 *   AchievementModal, RealmModal, RankModal, BattlePassModal, MonthCardModal,
 *   TeamModal, SectModal, SkillFloatButton 等
 */

import favicon from "../../../assets/favicon.png";
import { resolveAssetUrl } from "../../../services/api";

/* ───────── 通用 UI ───────── */

export const IMG_LOGO = resolveAssetUrl("/assets/logo2.png");
export const IMG_GAME_HEADER_LOGO = favicon;
export const IMG_COIN = resolveAssetUrl("/assets/ui/sh_icon_0006_jinbi_02.png");
export const IMG_LINGSHI = resolveAssetUrl("/assets/ui/lingshi.png");
export const IMG_TONGQIAN = resolveAssetUrl("/assets/ui/tongqian.png");
export const IMG_EQUIP_MALE = resolveAssetUrl("/assets/ui/ep-n.png");
export const IMG_EQUIP_FEMALE = resolveAssetUrl("/assets/ui/ep.png");
export const IMG_EXP = resolveAssetUrl("/assets/ui/icon_exp.png");

/* ───────── 地图 ───────── */

export const IMG_MAP_01 = resolveAssetUrl("/assets/map/cp_icon_map01.png");
export const IMG_MAP_02 = resolveAssetUrl("/assets/map/cp_icon_map02.png");
export const IMG_MAP_03 = resolveAssetUrl("/assets/map/cp_icon_map03.png");
export const IMG_MAP_04 = resolveAssetUrl("/assets/map/cp_icon_map04.png");
export const IMG_MAP_05 = resolveAssetUrl("/assets/map/cp_icon_map05.png");
export const IMG_MAP_06 = resolveAssetUrl("/assets/map/cp_icon_map06.png");
