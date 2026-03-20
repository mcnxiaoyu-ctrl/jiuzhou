/**
 * 伙伴名字共享规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定伙伴改名与角色改名共用的裁剪、长度规则，避免后续某个入口偷偷改成另一套限制。
 * 2. 做什么：验证伙伴改名文案保持“伙伴名”口径，而不是误用角色“道号”文案。
 * 3. 不做什么：不连接数据库，不覆盖易名符扣除与伙伴归属校验。
 *
 * 输入/输出：
 * - 输入：原始伙伴名字符串。
 * - 输出：归一化后的伙伴名，以及统一长度错误文案。
 *
 * 数据流/状态流：
 * 原始输入 -> `normalizePartnerNameInput` -> `getPartnerNameLengthError` -> 伙伴改名服务消费。
 *
 * 关键边界条件与坑点：
 * 1. 长度判断必须基于裁剪后的值，否则前后端会出现一个能过、一个不过的漂移。
 * 2. 伙伴文案必须明确是“伙伴名”，避免角色改名与伙伴改名共享 UI 时提示错位。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getPartnerNameLengthError,
  normalizePartnerNameInput,
  PARTNER_NAME_LENGTH_MESSAGE,
} from '../shared/partnerNameRules.js';

test('normalizePartnerNameInput: 应裁剪首尾空白', () => {
  assert.equal(normalizePartnerNameInput('  青萝  '), '青萝');
});

test('getPartnerNameLengthError: 非法长度应返回统一伙伴文案', () => {
  assert.equal(getPartnerNameLengthError('玄'), PARTNER_NAME_LENGTH_MESSAGE);
  assert.equal(
    getPartnerNameLengthError('一二三四五六七八九十一二三'),
    PARTNER_NAME_LENGTH_MESSAGE,
  );
});

test('getPartnerNameLengthError: 合法长度应返回 null', () => {
  assert.equal(getPartnerNameLengthError('青萝儿'), null);
});
