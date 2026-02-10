import React from 'react';
import { App, Button, Calendar, Modal, Radio, Select, Tag, Typography } from 'antd';
import type { CalendarProps } from 'antd';
import { createStyles } from 'antd-style';
import { clsx } from 'clsx';
import dayjs from 'dayjs';
import localeData from 'dayjs/plugin/localeData';
import type { Dayjs } from 'dayjs';
import { HolidayUtil, Lunar } from 'lunar-typescript';
import { doSignIn, getSignInOverview, type SignInRecordDto } from '../../../../services/api';
import { gameSocket } from '../../../../services/gameSocket';
import './index.scss';

interface SignInModalProps {
  open: boolean;
  onClose: () => void;
  onSigned?: () => void;
}

type OriginNodeElement = React.ReactElement<{ className?: string; children?: React.ReactNode }>;

type SignInStore = Record<string, SignInRecordDto>;

dayjs.extend(localeData);

const useStyle = createStyles(({ token, css, cx }) => {
  const lunar = css`
    color: ${token.colorTextTertiary};
    font-size: ${token.fontSizeSM}px;
  `;
  const weekend = css`
    color: ${token.colorError};
    &.gray {
      opacity: 0.4;
    }
  `;
  return {
    wrapper: css`
      width: 100%;
      max-width: 450px;
      border: 1px solid ${token.colorBorderSecondary};
      border-radius: ${token.borderRadiusOuter};
      padding: 5px;

      @media (max-width: 520px) {
        max-width: 100%;
        border: none;
        padding: 0;
      }
    `,
    dateCell: css`
      position: relative;
      &:before {
        content: '';
        position: absolute;
        inset-inline-start: 0;
        inset-inline-end: 0;
        top: 0;
        bottom: 0;
        margin: auto;
        max-width: 40px;
        max-height: 40px;
        background: transparent;
        transition: background-color 300ms;
        border-radius: ${token.borderRadiusOuter}px;
        border: 1px solid transparent;
        box-sizing: border-box;
      }
      &:hover:before {
        background: ${token.colorFillTertiary};
      }
    `,
    today: css`
      &:before {
        border: 1px solid ${token.colorPrimary};
      }
    `,
    text: css`
      position: relative;
      z-index: 1;
    `,
    lunar,
    signed: css`
      &:before {
        background: ${token.colorSuccessBg};
        border: 1px solid ${token.colorSuccessBorder};
      }
      &:hover:before {
        background: ${token.colorSuccessBg};
      }
    `,
    current: css`
      color: ${token.colorTextLightSolid};
      &:before {
        background: ${token.colorPrimary};
      }
      &:hover:before {
        background: ${token.colorPrimary};
        opacity: 0.8;
      }
      .${cx(lunar)} {
        color: ${token.colorTextLightSolid};
        opacity: 0.9;
      }
      .${cx(weekend)} {
        color: ${token.colorTextLightSolid};
      }
    `,
    monthCell: css`
      width: 120px;
      color: ${token.colorTextBase};
      border-radius: ${token.borderRadiusOuter}px;
      padding: 5px 0;
      &:hover {
        background: ${token.colorFillTertiary};
      }
    `,
    monthCellCurrent: css`
      color: ${token.colorTextLightSolid};
      background: ${token.colorPrimary};
      &:hover {
        background: ${token.colorPrimary};
        opacity: 0.8;
      }
    `,
    weekend,
  };
});

const SignInModal: React.FC<SignInModalProps> = ({ open, onClose, onSigned }) => {
  const { message } = App.useApp();
  const { styles } = useStyle({ test: true });

  const [selectDate, setSelectDate] = React.useState<Dayjs>(() => dayjs());
  const [panelDateDate, setPanelDate] = React.useState<Dayjs>(() => dayjs());

  const [loading, setLoading] = React.useState(false);
  const [overviewMonth, setOverviewMonth] = React.useState<string>(() => dayjs().format('YYYY-MM'));
  const [signInStore, setSignInStore] = React.useState<SignInStore>({});
  const [monthSignedCount, setMonthSignedCount] = React.useState(0);
  const [streakDays, setStreakDays] = React.useState(0);
  const [signedToday, setSignedToday] = React.useState(false);
  const [todayKey, setTodayKey] = React.useState(() => dayjs().format('YYYY-MM-DD'));

  const refreshOverview = React.useCallback(
    async (month: string) => {
      setLoading(true);
      try {
        const res = await getSignInOverview(month);
        if (!res.success || !res.data) {
          message.error(res.message || '获取签到信息失败');
          return;
        }
        setOverviewMonth(res.data.month);
        setSignInStore(res.data.records || {});
        setMonthSignedCount(res.data.monthSignedCount || 0);
        setStreakDays(res.data.streakDays || 0);
        setSignedToday(Boolean(res.data.signedToday));
        setTodayKey(res.data.today || dayjs().format('YYYY-MM-DD'));
      } catch (err) {
        const e = err as { message?: string };
        message.error(e?.message || '获取签到信息失败');
      } finally {
        setLoading(false);
      }
    },
    [message]
  );

  React.useEffect(() => {
    if (!open) return;
    const now = dayjs();
    setSelectDate(now);
    setPanelDate(now);
    refreshOverview(now.format('YYYY-MM'));
  }, [open, refreshOverview]);

  const selectedKey = selectDate.format('YYYY-MM-DD');
  const isTodaySelected = selectedKey === todayKey;

  const handleSignIn = async () => {
    if (!isTodaySelected) {
      message.warning('请选择今日日期进行签到');
      return;
    }
    if (signedToday) {
      message.info('今日已签到');
      return;
    }
    setLoading(true);
    try {
      const res = await doSignIn();
      if (!res.success || !res.data) {
        message.error(res.message || '签到失败');
        return;
      }
      message.success(`签到成功，获得灵石 +${res.data.reward}`);
      await refreshOverview(overviewMonth);
      gameSocket.refreshCharacter();
      onSigned?.();
    } catch (err) {
      const e = err as { message?: string };
      message.error(e?.message || '签到失败');
    } finally {
      setLoading(false);
    }
  };

  const onPanelChange = (value: Dayjs) => {
    setPanelDate(value);
    refreshOverview(value.format('YYYY-MM'));
  };

  const onDateChange: CalendarProps<Dayjs>['onSelect'] = (value, selectInfo) => {
    if (selectInfo.source === 'date') {
      setSelectDate(value);
    }
  };

  const cellRender: CalendarProps<Dayjs>['fullCellRender'] = (date, info) => {
    const d = Lunar.fromDate(date.toDate());
    const lunar = d.getDayInChinese();
    const solarTerm = d.getJieQi();
    const isWeekend = date.day() === 6 || date.day() === 0;
    const h = HolidayUtil.getHoliday(date.get('year'), date.get('month') + 1, date.get('date'));
    const displayHoliday = h?.getTarget() === h?.getDay() ? h?.getName() : undefined;
    if (info.type === 'date') {
      const signed = !!signInStore[date.format('YYYY-MM-DD')];
      const isCurrent = selectDate.isSame(date, 'date');
      return React.cloneElement(info.originNode as OriginNodeElement, {
        ...(info.originNode as OriginNodeElement).props,
        className: clsx(styles.dateCell, {
          [styles.signed]: signed && !isCurrent,
          [styles.current]: isCurrent,
          [styles.today]: date.isSame(dayjs(), 'date'),
        }),
        children: (
          <div className={styles.text}>
            <span
              className={clsx({
                [styles.weekend]: isWeekend,
                gray: !panelDateDate.isSame(date, 'month'),
              })}
            >
              {date.get('date')}
            </span>
            {info.type === 'date' && (
              <div className={styles.lunar}>
                {displayHoliday || solarTerm || lunar}
              </div>
            )}
          </div>
        ),
      });
    }

    if (info.type === 'month') {
      // Due to the fact that a solar month is part of the lunar month X and part of the lunar month X+1,
      // when rendering a month, always take X as the lunar month of the month
      const d2 = Lunar.fromDate(new Date(date.get('year'), date.get('month')));
      const month = d2.getMonthInChinese();
      return (
        <div
          className={clsx(styles.monthCell, {
            [styles.monthCellCurrent]: selectDate.isSame(date, 'month'),
          })}
        >
          {date.get('month') + 1}月（{month}月）
        </div>
      );
    }
  };

  const getYearLabel = (year: number) => {
    const d = Lunar.fromDate(new Date(year + 1, 0));
    return `${d.getYearInChinese()}年（${d.getYearInGanZhi()}${d.getYearShengXiao()}年）`;
  };

  const getMonthLabel = (month: number, value: Dayjs) => {
    const d = Lunar.fromDate(new Date(value.year(), month));
    const lunar = d.getMonthInChinese();
    return `${month + 1}月（${lunar}月）`;
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title="签到"
      centered
      width="95vw"
      style={{ maxWidth: 520 }}
      className="signin-modal"
      destroyOnHidden
      maskClosable
    >
      <div className={clsx(styles.wrapper, 'signin-wrapper')}>
        <div className="signin-calendar">
          <Calendar
            fullCellRender={cellRender}
            fullscreen={false}
            onPanelChange={onPanelChange}
            onSelect={onDateChange}
            headerRender={({ value, type, onChange, onTypeChange }) => {
              const start = 0;
              const end = 12;
              const monthOptions = [];

              let current = value.clone();
              const localeData = value.localeData();
              const months = [];
              for (let i = 0; i < 12; i++) {
                current = current.month(i);
                months.push(localeData.monthsShort(current));
              }

              for (let i = start; i < end; i++) {
                monthOptions.push({
                  label: getMonthLabel(i, value),
                  value: i,
                });
              }

              const year = value.year();
              const month = value.month();
              const options = [];
              for (let i = year - 10; i < year + 10; i += 1) {
                options.push({
                  label: getYearLabel(i),
                  value: i,
                });
              }
              return (
                <div className="signin-header">
                  <Select
                    size="small"
                    popupMatchSelectWidth={false}
                    className="signin-year-select"
                    value={year}
                    options={options}
                    onChange={(newYear) => {
                      const now = value.clone().year(newYear);
                      onChange(now);
                    }}
                  />
                  <Select
                    size="small"
                    popupMatchSelectWidth={false}
                    className="signin-month-select"
                    value={month}
                    options={monthOptions}
                    onChange={(newMonth) => {
                      const now = value.clone().month(newMonth);
                      onChange(now);
                    }}
                  />
                  <Radio.Group size="small" onChange={(e) => onTypeChange(e.target.value)} value={type}>
                    <Radio.Button value="month">月</Radio.Button>
                    <Radio.Button value="year">年</Radio.Button>
                  </Radio.Group>
                </div>
              );
            }}
          />
        </div>

        <div className="signin-footer">
          <div className="signin-footer-info">
            <div className="signin-footer-date">
              <Typography.Text type="secondary" className="signin-footer-label">已选：</Typography.Text>
              <Typography.Text className="signin-footer-value">{selectedKey}</Typography.Text>
            </div>
            <div className="signin-footer-tags">
              <Tag color={signedToday ? 'success' : 'default'}>{signedToday ? '今日已签到' : '今日未签到'}</Tag>
              <Tag color="processing">本月已签 {monthSignedCount} 天</Tag>
              <Tag color="purple" className="signin-streak-tag">连续 {streakDays} 天</Tag>
            </div>
          </div>
          <Button type="primary" block loading={loading} disabled={!isTodaySelected || signedToday} onClick={handleSignIn}>
            {signedToday ? '今日已签到' : '签到'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default SignInModal;
