import { query } from '../../config/database.js';

/**
 * 角色奖励补发邮件 Outbox 存储
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：承接“背包已满后转邮件补发”的持久化 outbox，保证真实入包提交后，后续补发邮件仍可重试恢复。
 * 2. 做什么：集中收敛 outbox 的插入、批量领取候选、成功完成与失败重试更新，避免奖励 flush 主链路散落手写 SQL。
 * 3. 不做什么：不直接发送邮件，不推送前端，也不负责 Redis claim/finalize/restore。
 *
 * 输入 / 输出：
 * - `enqueueCharacterItemGrantOverflowMail(entries)`：输入当前事务内生成的补发条目，输出 Promise<void>。
 * - `claimCharacterItemGrantOverflowMailBatch(limit, characterId?)`：输入批大小与可选角色 ID，输出待处理 outbox ID 列表。
 * - `loadCharacterItemGrantOverflowMailForUpdate(outboxId)`：输入 outbox ID，输出当前事务内锁定后的完整 outbox 行。
 * - `finalizeCharacterItemGrantOverflowMail(outboxId, sentMailId)`：输入 outbox ID 与最终邮件 ID，输出 Promise<void>。
 * - `restoreCharacterItemGrantOverflowMailAttempt(outboxId, errorMessage)`：输入 outbox ID 与失败原因，输出 Promise<void>。
 *
 * 数据流 / 状态流：
 * 奖励 flush 事务 -> enqueue outbox -> 锁外批处理读取候选 -> 单行 `FOR UPDATE` -> send mail
 * -> finalize 成功 / restore 失败重试。
 *
 * 复用设计说明：
 * 1. 未来所有“主事务先提交、后续副作用重试恢复”的邮件补发场景都可复用这一层，不再为不同奖励来源各写一套表与状态更新 SQL。
 * 2. 高频变化点是“哪些奖励需要转邮件”，不是 outbox 状态机，因此把状态转移统一收口在这里最能减少重复维护。
 *
 * 关键边界条件与坑点：
 * 1. outbox 只承接已经在主事务中确定要补发的附件，不能把“是否背包已满”的判定拖到这里再做。
 * 2. 失败重试只更新 outbox 状态，不回滚主事务里已成功入包的物品，也不回滚 Redis 已 finalize 的 grant。
 */

type CharacterItemGrantOverflowMailMetadataValue = string | number | boolean | null;

export type CharacterItemGrantOverflowMailAttachment = {
  item_def_id: string;
  qty: number;
  options?: {
    bindType?: string;
    equipOptions?: Record<string, CharacterItemGrantOverflowMailMetadataValue | CharacterItemGrantOverflowMailMetadataValue[] | Record<string, CharacterItemGrantOverflowMailMetadataValue>>;
    metadata?: Record<string, CharacterItemGrantOverflowMailMetadataValue | undefined>;
    quality?: string;
    qualityRank?: number;
  };
};

export type CharacterItemGrantOverflowMailOutboxEntry = {
  characterId: number;
  recipientUserId: number;
  recipientCharacterId: number;
  title: string;
  content: string;
  attachItems: CharacterItemGrantOverflowMailAttachment[];
  idleSessionIds: string[];
  expireDays: number;
};

export type CharacterItemGrantOverflowMailOutboxRow = {
  id: number;
  characterId: number;
  recipientUserId: number;
  recipientCharacterId: number;
  title: string;
  content: string;
  attachItems: CharacterItemGrantOverflowMailAttachment[];
  idleSessionIds: string[];
  expireDays: number;
  attemptCount: number;
};

type RawCharacterItemGrantOverflowMailOutboxRow = {
  id: number | string;
  character_id: number | string;
  recipient_user_id: number | string;
  recipient_character_id: number | string;
  title: string;
  content: string;
  attach_items: CharacterItemGrantOverflowMailAttachment[] | string | null;
  idle_session_ids: string[] | string | null;
  expire_days: number | string;
  attempt_count: number | string;
};

const CHARACTER_ITEM_GRANT_MAIL_OUTBOX_SOURCE = 'character_item_grant_overflow';
const CHARACTER_ITEM_GRANT_MAIL_OUTBOX_RETRY_DELAY_MS = 15_000;

export const CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_PENDING = 'pending';
export const CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_FAILED = 'failed';
export const CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_SENT = 'sent';

const normalizePositiveInt = (value: number | string): number => {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`奖励补发邮件 outbox 数值非法: ${String(value)}`);
  }
  return normalized;
};

const normalizeAttachmentList = (
  raw: CharacterItemGrantOverflowMailAttachment[] | string | null,
): CharacterItemGrantOverflowMailAttachment[] => {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw !== 'string' || raw.trim().length <= 0) {
    return [];
  }
  return JSON.parse(raw) as CharacterItemGrantOverflowMailAttachment[];
};

const normalizeIdleSessionIds = (raw: string[] | string | null): string[] => {
  if (Array.isArray(raw)) {
    return raw.filter((sessionId) => typeof sessionId === 'string' && sessionId.trim().length > 0);
  }
  if (typeof raw !== 'string' || raw.trim().length <= 0) {
    return [];
  }
  return (JSON.parse(raw) as string[])
    .filter((sessionId) => typeof sessionId === 'string' && sessionId.trim().length > 0);
};

const mapOutboxRow = (
  row: RawCharacterItemGrantOverflowMailOutboxRow,
): CharacterItemGrantOverflowMailOutboxRow => {
  return {
    id: normalizePositiveInt(row.id),
    characterId: normalizePositiveInt(row.character_id),
    recipientUserId: normalizePositiveInt(row.recipient_user_id),
    recipientCharacterId: normalizePositiveInt(row.recipient_character_id),
    title: String(row.title || '').trim(),
    content: String(row.content || ''),
    attachItems: normalizeAttachmentList(row.attach_items),
    idleSessionIds: normalizeIdleSessionIds(row.idle_session_ids),
    expireDays: normalizePositiveInt(row.expire_days),
    attemptCount: Math.max(0, Math.floor(Number(row.attempt_count) || 0)),
  };
};

export const buildCharacterItemGrantOverflowMailSourceRefId = (outboxId: number): string =>
  `${CHARACTER_ITEM_GRANT_MAIL_OUTBOX_SOURCE}:${outboxId}`;

export const enqueueCharacterItemGrantOverflowMail = async (
  entries: CharacterItemGrantOverflowMailOutboxEntry[],
): Promise<void> => {
  if (entries.length <= 0) {
    return;
  }

  await query(
    `
      INSERT INTO character_item_grant_mail_outbox (
        character_id,
        recipient_user_id,
        recipient_character_id,
        title,
        content,
        attach_items,
        idle_session_ids,
        expire_days
      )
      SELECT
        entry.character_id,
        entry.recipient_user_id,
        entry.recipient_character_id,
        entry.title,
        entry.content,
        entry.attach_items,
        entry.idle_session_ids,
        entry.expire_days
      FROM jsonb_to_recordset($1::jsonb) AS entry (
        character_id integer,
        recipient_user_id bigint,
        recipient_character_id bigint,
        title text,
        content text,
        attach_items jsonb,
        idle_session_ids jsonb,
        expire_days integer
      )
    `,
    [
      JSON.stringify(
        entries.map((entry) => ({
          character_id: entry.characterId,
          recipient_user_id: entry.recipientUserId,
          recipient_character_id: entry.recipientCharacterId,
          title: entry.title,
          content: entry.content,
          attach_items: entry.attachItems,
          idle_session_ids: entry.idleSessionIds,
          expire_days: entry.expireDays,
        })),
      ),
    ],
  );
};

export const claimCharacterItemGrantOverflowMailBatch = async (
  limit: number,
  characterId?: number,
): Promise<number[]> => {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const params: Array<number> = [normalizedLimit];
  const characterFilterSql =
    characterId !== undefined && Number.isInteger(characterId) && characterId > 0
      ? (() => {
          params.push(characterId);
          return 'AND character_id = $2';
        })()
      : '';

  const result = await query<{ id: number | string }>(
    `
      SELECT id
      FROM character_item_grant_mail_outbox
      WHERE status = ANY($${params.length + 1}::text[])
        AND next_attempt_at <= NOW()
        ${characterFilterSql}
      ORDER BY created_at ASC, id ASC
      LIMIT $1
    `,
    [...params, [CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_PENDING, CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_FAILED]],
  );

  return result.rows
    .map((row) => Math.floor(Number(row.id)))
    .filter((outboxId) => Number.isInteger(outboxId) && outboxId > 0);
};

export const loadCharacterItemGrantOverflowMailForUpdate = async (
  outboxId: number,
): Promise<CharacterItemGrantOverflowMailOutboxRow | null> => {
  const result = await query<RawCharacterItemGrantOverflowMailOutboxRow>(
    `
      SELECT
        id,
        character_id,
        recipient_user_id,
        recipient_character_id,
        title,
        content,
        attach_items,
        idle_session_ids,
        expire_days,
        attempt_count
      FROM character_item_grant_mail_outbox
      WHERE id = $1
        AND status = ANY($2::text[])
        AND next_attempt_at <= NOW()
      FOR UPDATE SKIP LOCKED
    `,
    [
      outboxId,
      [CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_PENDING, CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_FAILED],
    ],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return mapOutboxRow(row);
};

export const finalizeCharacterItemGrantOverflowMail = async (
  outboxId: number,
  sentMailId: number,
): Promise<void> => {
  await query(
    `
      UPDATE character_item_grant_mail_outbox
      SET status = $2,
          sent_mail_id = $3,
          sent_at = NOW(),
          attempt_count = attempt_count + 1,
          last_error = NULL,
          updated_at = NOW()
      WHERE id = $1
    `,
    [outboxId, CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_SENT, sentMailId],
  );
};

export const restoreCharacterItemGrantOverflowMailAttempt = async (
  outboxId: number,
  errorMessage: string,
): Promise<void> => {
  await query(
    `
      UPDATE character_item_grant_mail_outbox
      SET status = $2,
          attempt_count = attempt_count + 1,
          last_error = $3,
          next_attempt_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
          updated_at = NOW()
      WHERE id = $1
    `,
    [
      outboxId,
      CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_FAILED,
      errorMessage,
      CHARACTER_ITEM_GRANT_MAIL_OUTBOX_RETRY_DELAY_MS,
    ],
  );
};

export const countPendingCharacterItemGrantOverflowMail = async (): Promise<number> => {
  const result = await query<{ total: number | string }>(
    `
      SELECT COUNT(*)::bigint AS total
      FROM character_item_grant_mail_outbox
      WHERE status = ANY($1::text[])
        AND next_attempt_at <= NOW()
    `,
    [[CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_PENDING, CHARACTER_ITEM_GRANT_MAIL_OUTBOX_STATUS_FAILED]],
  );

  const total = Number(result.rows[0]?.total ?? 0);
  return Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0;
};
