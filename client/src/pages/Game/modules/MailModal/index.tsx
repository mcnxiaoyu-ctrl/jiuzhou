import {
  App,
  Badge,
  Button,
  Empty,
  Modal,
  Progress,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  EyeOutlined,
  GiftOutlined,
  InboxOutlined,
  LeftOutlined,
  MailOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getMailList,
  readMail,
  claimMailAttachments,
  deleteMail,
  deleteAllMails,
  markAllMailsRead,
} from "../../../../services/api";
import type { MailDto } from "../../../../services/api";
import { useIsMobile } from "../../shared/responsive";
import { formatDateTimeToMinute } from "../../shared/time";
import "./index.scss";

interface MailModalProps {
  open: boolean;
  onClose: () => void;
}

// 统一邮件读状态与附件状态判断，供列表渲染、计数和删除逻辑复用，避免同规则重复散落。
const isMailRead = (mail: MailDto): boolean => !!mail.readAt;

const hasAttachments = (mail: MailDto): boolean =>
  mail.attachSilver > 0 ||
  mail.attachSpiritStones > 0 ||
  (mail.attachItems && mail.attachItems.length > 0);

const hasUnclaimedAttachments = (mail: MailDto): boolean =>
  !mail.claimedAt && hasAttachments(mail);

const MailModal: React.FC<MailModalProps> = ({ open, onClose }) => {
  const { message, modal } = App.useApp();
  const [mails, setMails] = useState<MailDto[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  // 逐封领取进度：null 表示未在批量领取中
  const [claimProgress, setClaimProgress] = useState<{
    total: number;
    current: number;
  } | null>(null);
  const stopClaimRef = useRef(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [showMobileDetail, setShowMobileDetail] = useState(false);
  const isMobile = useIsMobile();

  // 加载邮件列表
  const loadMails = useCallback(
    async (options?: { resetActive?: boolean }) => {
      const resetActive = !!options?.resetActive;
      setLoading(true);
      try {
        const res = await getMailList(1, 100);
        if (res.success && res.data) {
          const nextMails = res.data.mails;

          setMails(nextMails);
          setUnreadCount(res.data.unreadCount);
          setUnclaimedCount(res.data.unclaimedCount);

          // 自动选中邮件（支持打开弹窗时重置为首封）
          setActiveId((prev) => {
            if (nextMails.length === 0) return null;
            if (resetActive) return nextMails[0].id;
            if (prev && nextMails.some((m) => m.id === prev)) return prev;
            return nextMails[0].id;
          });
        }
      } catch {
        void 0;
      } finally {
        setLoading(false);
      }
    },
    [message],
  );

  // 打开时加载
  useEffect(() => {
    if (open) {
      setShowMobileDetail(false);
      void loadMails({ resetActive: true });
    }
  }, [open, loadMails]);

  const safeActiveId = useMemo(() => {
    if (activeId && mails.some((m) => m.id === activeId)) return activeId;
    return mails[0]?.id ?? null;
  }, [activeId, mails]);

  const activeMail = useMemo(
    () => mails.find((m) => m.id === safeActiveId) ?? null,
    [mails, safeActiveId],
  );
  const readMails = useMemo(() => mails.filter(isMailRead), [mails]);
  const readMailCount = readMails.length;

  // 打开邮件（标记已读）
  const openMail = async (id: number) => {
    setActiveId(id);
    if (isMobile) setShowMobileDetail(true);
    const mail = mails.find((m) => m.id === id);
    if (mail && !mail.readAt) {
      try {
        const res = await readMail(id);
        if (res.success) {
          setMails((prev) =>
            prev.map((m) =>
              m.id === id ? { ...m, readAt: new Date().toISOString() } : m,
            ),
          );
          setUnreadCount((c) => Math.max(0, c - 1));
        }
      } catch {
        // 静默失败
      }
    }
  };

  // 领取附件
  const claimAttachments = async (id: number) => {
    const target = mails.find((m) => m.id === id);
    if (!target) return;

    const mailHasAttachments = hasAttachments(target);

    if (!mailHasAttachments) {
      message.info("该邮件没有附件");
      return;
    }
    if (target.claimedAt) {
      message.info("附件已领取");
      return;
    }

    setClaiming(true);
    try {
      const res = await claimMailAttachments(id);
      if (res.success) {
        setMails((prev) =>
          prev.map((m) =>
            m.id === id
              ? {
                  ...m,
                  claimedAt: new Date().toISOString(),
                  readAt: m.readAt ?? new Date().toISOString(),
                }
              : m,
          ),
        );
        setUnclaimedCount((c) => Math.max(0, c - 1));

        // 显示奖励
        const rewards: string[] = [];
        if (res.rewards?.silver) rewards.push(`银两 +${res.rewards.silver}`);
        if (res.rewards?.spiritStones)
          rewards.push(`灵石 +${res.rewards.spiritStones}`);
        if (res.rewards?.itemIds?.length)
          rewards.push(`物品 x${res.rewards.itemIds.length}`);
        message.success(
          `领取成功${rewards.length > 0 ? "：" + rewards.join("，") : ""}`,
        );
      } else {
        void 0;
      }
    } catch {
      void 0;
    } finally {
      setClaiming(false);
    }
  };

  // 停止逐封领取
  const stopClaimAll = () => {
    stopClaimRef.current = true;
  };

  // 逐封领取：前端遍历未领取邮件，逐封调用 claimMailAttachments。
  // 关键约束：
  // 1) 支持手动停止；
  // 2) 任意一封领取失败（接口返回失败或请求异常）时立即中断，不再继续后续邮件。
  const claimAll = async () => {
    const unclaimedMails = mails.filter(hasUnclaimedAttachments);
    if (unclaimedMails.length === 0) {
      message.info("没有可领取的附件");
      return;
    }

    stopClaimRef.current = false;
    const total = unclaimedMails.length;
    setClaimProgress({ total, current: 0 });
    setClaiming(true);

    let claimedCount = 0;
    let claimErrorMessage = "";
    let totalSilver = 0;
    let totalSpiritStones = 0;
    let totalItemCount = 0;

    for (let i = 0; i < unclaimedMails.length; i++) {
      if (stopClaimRef.current) break;

      const mail = unclaimedMails[i];
      setClaimProgress({ total, current: i + 1 });

      try {
        const res = await claimMailAttachments(mail.id);
        if (res.success) {
          claimedCount += 1;
          totalSilver += res.rewards?.silver ?? 0;
          totalSpiritStones += res.rewards?.spiritStones ?? 0;
          totalItemCount += res.rewards?.itemIds?.length ?? 0;

          // 实时更新该邮件的已领取状态
          setMails((prev) =>
            prev.map((m) =>
              m.id === mail.id
                ? {
                    ...m,
                    claimedAt: new Date().toISOString(),
                    readAt: m.readAt ?? new Date().toISOString(),
                  }
                : m,
            ),
          );
          setUnclaimedCount((c) => Math.max(0, c - 1));
        } else {
          claimErrorMessage = res.message;
          break;
        }
      } catch (error) {
        claimErrorMessage =
          error instanceof Error && error.message
            ? error.message
            : "领取失败";
        break;
      }
    }

    setClaimProgress(null);
    setClaiming(false);

    if (claimErrorMessage) {
      if (claimedCount === 0) {
        message.error(`领取失败：${claimErrorMessage}`);
        return;
      }

      const rewards: string[] = [];
      if (totalSilver) rewards.push(`银两 +${totalSilver}`);
      if (totalSpiritStones) rewards.push(`灵石 +${totalSpiritStones}`);
      if (totalItemCount) rewards.push(`物品 x${totalItemCount}`);
      message.error(
        `领取到第 ${claimedCount} 封后中断：${claimErrorMessage}${rewards.length > 0 ? `（已获得：${rewards.join("，")}）` : ""}`,
      );
      return;
    }

    // 汇总提示
    const stopped = stopClaimRef.current;
    if (claimedCount === 0) {
      message.info(stopped ? "已停止，未领取任何附件" : "没有可领取的附件");
      return;
    }

    const rewards: string[] = [];
    if (totalSilver) rewards.push(`银两 +${totalSilver}`);
    if (totalSpiritStones) rewards.push(`灵石 +${totalSpiritStones}`);
    if (totalItemCount) rewards.push(`物品 x${totalItemCount}`);
    const stoppedTip = stopped ? "（已手动停止）" : "";
    message.success(
      `已领取 ${claimedCount} 封邮件附件${rewards.length > 0 ? "：" + rewards.join("，") : ""}${stoppedTip}`,
    );
  };

  // 一键已读
  const markAllRead = async () => {
    if (unreadCount === 0) {
      message.info("没有未读邮件");
      return;
    }

    try {
      const res = await markAllMailsRead();
      if (res.success) {
        setMails((prev) =>
          prev.map((m) =>
            m.readAt ? m : { ...m, readAt: new Date().toISOString() },
          ),
        );
        setUnreadCount(0);
        message.success(`已读 ${res.readCount} 封邮件`);
      } else {
        void 0;
      }
    } catch {
      void 0;
    }
  };

  // 一键删除
  const deleteAll = () => {
    if (readMailCount === 0) {
      message.info("没有已读邮件可删除");
      return;
    }
    modal.confirm({
      title: "一键删除已读",
      content: "确认删除所有已读邮件？未读邮件会保留，删除后不可恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const res = await deleteAllMails(true);
          if (res.success) {
            const unreadMails = mails.filter((mail) => !isMailRead(mail));
            setMails(unreadMails);
            setActiveId((prev) => {
              if (prev && unreadMails.some((mail) => mail.id === prev))
                return prev;
              return unreadMails[0]?.id ?? null;
            });
            if (unreadMails.length === 0) {
              setShowMobileDetail(false);
            }
            setUnreadCount(unreadMails.length);
            setUnclaimedCount(
              unreadMails.filter(hasUnclaimedAttachments).length,
            );
            message.success(`已删除 ${res.deletedCount} 封已读邮件`);
          }
        } catch {
          void 0;
        }
      },
    });
  };

  // 删除单封邮件
  const handleDeleteMail = (id: number) => {
    const target = mails.find((m) => m.id === id);
    if (!target) return;

    const targetHasUnclaimedAttachments = hasUnclaimedAttachments(target);

    modal.confirm({
      title: "删除邮件",
      content: targetHasUnclaimedAttachments
        ? "该邮件有未领取的附件，确认删除？删除后不可恢复。"
        : "确认删除该邮件？删除后不可恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const res = await deleteMail(id);
          if (res.success) {
            const newMails = mails.filter((m) => m.id !== id);
            setMails(newMails);
            if (activeId === id) {
              setActiveId(newMails[0]?.id ?? null);
              if (newMails.length === 0) setShowMobileDetail(false);
            }
            // 更新计数
            if (!target.readAt) setUnreadCount((c) => Math.max(0, c - 1));
            if (targetHasUnclaimedAttachments)
              setUnclaimedCount((c) => Math.max(0, c - 1));
            message.success("邮件已删除");
          }
        } catch {
          void 0;
        }
      },
    });
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width="min(980px, calc(100vw - 16px))"
      className="mail-modal"
      destroyOnHidden
      maskClosable
    >
      <Spin spinning={loading}>
        <div className="mail-modal-shell">
          <div
            className={`mail-modal-left ${showMobileDetail ? "mobile-hidden" : ""}`}
          >
            <div className="mail-left-header">
              <div className="mail-left-title">
                <MailOutlined />
                <span>邮箱</span>
                <Badge count={unreadCount} size="small" />
              </div>
              <Space size={8} className="mail-left-actions">
                <Tooltip title="刷新">
                  <Button
                    size="small"
                    type="text"
                    icon={<ReloadOutlined />}
                    onClick={() => void loadMails()}
                  />
                </Tooltip>
                {claimProgress ? (
                  <Button size="small" danger onClick={stopClaimAll}>
                    停止
                  </Button>
                ) : (
                  <Tooltip title="一键领取">
                    <Button
                      size="small"
                      type="text"
                      icon={<GiftOutlined />}
                      onClick={claimAll}
                      loading={claiming}
                      disabled={unclaimedCount === 0}
                    />
                  </Tooltip>
                )}
                <Tooltip title="一键已读">
                  <Button
                    size="small"
                    type="text"
                    icon={<EyeOutlined />}
                    onClick={markAllRead}
                    disabled={unreadCount === 0}
                  />
                </Tooltip>
                <Tooltip title="一键删除已读">
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={deleteAll}
                    disabled={readMailCount === 0}
                  />
                </Tooltip>
              </Space>
            </div>
            {claimProgress && (
              <div className="mail-claim-progress">
                <Progress
                  percent={Math.round(
                    (claimProgress.current / claimProgress.total) * 100,
                  )}
                  size="small"
                  format={() =>
                    `${claimProgress.current}/${claimProgress.total}`
                  }
                />
              </div>
            )}
            <div className="mail-list">
              {mails.map((m) => {
                const isActive = m.id === safeActiveId;
                const isUnread = !isMailRead(m);
                const hasGift = hasAttachments(m);
                const giftClaimed = hasGift && !!m.claimedAt;
                return (
                  <div
                    key={m.id}
                    className={`mail-item ${isActive ? "is-active" : ""} ${isUnread ? "is-unread" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => openMail(m.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") openMail(m.id);
                    }}
                  >
                    <div className="mail-item-top">
                      <div className="mail-item-title">
                        {isUnread ? <span className="mail-dot" /> : null}
                        <span className="mail-title-text">{m.title}</span>
                      </div>
                      <div className="mail-item-time">
                        {formatDateTimeToMinute(m.createdAt)}
                      </div>
                    </div>
                    <div className="mail-item-meta">
                      <span className="mail-from">{m.senderName}</span>
                      <span className="mail-tags">
                        {hasGift ? (
                          <Tag color={giftClaimed ? "default" : "gold"}>
                            {giftClaimed ? "已领取" : "有附件"}
                          </Tag>
                        ) : (
                          <Tag color="default">无附件</Tag>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
              {mails.length === 0 && !loading ? (
                <div className="mail-empty">
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无邮件"
                  />
                </div>
              ) : null}
            </div>
          </div>

          <div
            className={`mail-modal-right ${showMobileDetail ? "mobile-visible" : ""}`}
          >
            {activeMail ? (
              <>
                {isMobile ? (
                  <div
                    className="mail-modal-mobile-back"
                    role="button"
                    tabIndex={0}
                    onClick={() => setShowMobileDetail(false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ")
                        setShowMobileDetail(false);
                    }}
                  >
                    <LeftOutlined /> 返回邮件列表
                  </div>
                ) : null}
                <div className="mail-detail-header">
                  <div className="mail-detail-title">{activeMail.title}</div>
                  <Space size={8} className="mail-detail-actions">
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => handleDeleteMail(activeMail.id)}
                    >
                      删除
                    </Button>
                  </Space>
                </div>

                <div className="mail-detail-meta">
                  <Tag color={isMailRead(activeMail) ? "default" : "blue"}>
                    {isMailRead(activeMail) ? "已读" : "未读"}
                  </Tag>
                  <Tag color="default">发件人：{activeMail.senderName}</Tag>
                  <Tag color="default">
                    时间：{formatDateTimeToMinute(activeMail.createdAt)}
                  </Tag>
                  {activeMail.expireAt && (
                    <Tag color="orange">
                      过期：{formatDateTimeToMinute(activeMail.expireAt)}
                    </Tag>
                  )}
                </div>

                <div className="mail-detail-body">
                  <Typography.Paragraph className="mail-content">
                    {activeMail.content}
                  </Typography.Paragraph>
                </div>

                <div className="mail-detail-footer">
                  <div className="mail-attachments">
                    <div className="mail-attachments-title">
                      <InboxOutlined />
                      <span>附件</span>
                    </div>
                    {hasAttachments(activeMail) ? (
                      <div className="mail-attachments-list">
                        {activeMail.attachSilver > 0 && (
                          <div className="mail-attachment">
                            <span className="mail-attachment-name">银两</span>
                            <span className="mail-attachment-amount">
                              x{activeMail.attachSilver.toLocaleString()}
                            </span>
                          </div>
                        )}
                        {activeMail.attachSpiritStones > 0 && (
                          <div className="mail-attachment">
                            <span className="mail-attachment-name">灵石</span>
                            <span className="mail-attachment-amount">
                              x{activeMail.attachSpiritStones.toLocaleString()}
                            </span>
                          </div>
                        )}
                        {activeMail.attachItems?.map((item, idx) => {
                          const qualityColorMap: Record<string, string> = {
                            天: "var(--rarity-tian)",
                            地: "var(--rarity-di)",
                            玄: "var(--rarity-xuan)",
                            黄: "var(--rarity-huang)",
                          };
                          const nameColor = item.quality
                            ? qualityColorMap[item.quality]
                            : undefined;
                          return (
                            <div key={idx} className="mail-attachment">
                              <span
                                className="mail-attachment-name"
                                style={
                                  nameColor ? { color: nameColor } : undefined
                                }
                              >
                                {item.item_name || item.item_def_id}
                              </span>
                              <span className="mail-attachment-amount">
                                x{item.qty}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="mail-attachments-empty">无附件</div>
                    )}
                  </div>
                  <Button
                    type="primary"
                    icon={<GiftOutlined />}
                    disabled={
                      !hasAttachments(activeMail) || !!activeMail.claimedAt
                    }
                    loading={claiming}
                    onClick={() => claimAttachments(activeMail.id)}
                  >
                    {!hasAttachments(activeMail)
                      ? "无可领取"
                      : activeMail.claimedAt
                        ? "已领取"
                        : "领取附件"}
                  </Button>
                </div>
              </>
            ) : (
              <div className="mail-right-empty">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="请选择一封邮件"
                />
              </div>
            )}
          </div>
        </div>
      </Spin>
    </Modal>
  );
};

export default MailModal;
