/**
 * 入宗前的宗门大厅面板。
 * 输入：宗门列表、搜索关键字、加入状态与操作回调。
 * 输出：可检索/申请/创建宗门的 UI。
 * 边界：当玩家已有 pending 申请时，只允许继续查看，不允许对其他宗门重复申请。
 */
import { Button, Input, Table, Tag, Tooltip } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { SectJoinState, SectListItemVm } from '../types';
import { useIsMobile } from '../../../shared/responsive';

/**
 * 根据宗门等级返回对应品质颜色的 Tag
 */
const renderSectLevelTag = (level: number) => {
  let color = 'default';
  if (level >= 10) color = 'gold';
  else if (level >= 7) color = 'purple';
  else if (level >= 4) color = 'blue';
  return <Tag color={color} style={{ margin: 0 }}>Lv.{level}</Tag>;
};

/**
 * 根据最低境界返回相应的国风分色 Tag
 */
const renderRealmTag = (realm: string) => {
  const name = realm.trim();
  let color = 'default';
  if (name.includes('凡人')) color = 'default';
  else if (name.includes('练气') || name.includes('炼气')) color = 'cyan';
  else if (name.includes('筑基')) color = 'blue';
  else if (name.includes('金丹')) color = 'purple';
  else if (name.includes('元婴')) color = 'magenta';
  else if (name.includes('化神')) color = 'volcano';
  else if (name.includes('合体') || name.includes('炼虚')) color = 'orange';
  else if (name.includes('渡劫') || name.includes('大乘')) color = 'gold';
  return <Tag color={color} style={{ margin: 0 }}>{name}</Tag>;
};

/**
 * 成员数量已满或快满时渲染对应警示色的节点
 */
const renderMemberCountNode = (members: number, memberCap: number) => {
  const isFull = members >= memberCap;
  const isCloseToFull = members >= memberCap - 5;
  let color = 'var(--text-color)';
  let fontWeight: 'bold' | 'normal' = 'normal';
  if (isFull) {
    color = 'var(--danger-color)';
    fontWeight = 'bold';
  } else if (isCloseToFull) {
    color = 'var(--warning-color)';
    fontWeight = 'bold';
  }
  return (
    <span style={{ color, fontWeight, fontSize: '12px' }}>
      {members}/{memberCap}
    </span>
  );
};

interface NoSectHallPanelProps {
  listLoading: boolean;
  searchKeyword: string;
  onSearchKeywordChange: (value: string) => void;
  onSearch: () => void;
  onOpenCreate: () => void;
  sects: SectListItemVm[];
  joinState: SectJoinState;
  activeSectId: string;
  actionLoadingKey: string | null;
  onApplyJoin: (sectId: string) => void;
}

const NoSectHallPanel: React.FC<NoSectHallPanelProps> = ({
  listLoading,
  searchKeyword,
  onSearchKeywordChange,
  onSearch,
  onOpenCreate,
  sects,
  joinState,
  activeSectId,
  actionLoadingKey,
  onApplyJoin,
}) => {

  const isMobile = useIsMobile();

  const renderActionButton = (sectId: string) => {
    const isCurrent = activeSectId === sectId;
    const isPending = joinState === 'pending' && isCurrent;
    const disabled = (joinState === 'pending' && !isCurrent) || joinState === 'joined';
    return (
      <Button
        size="small"
        type={isPending ? 'default' : 'primary'}
        disabled={disabled}
        loading={actionLoadingKey === `apply-${sectId}`}
        onClick={() => {
          void onApplyJoin(sectId);
        }}
      >
        {isPending ? '已申请' : '申请加入'}
      </Button>
    );
  };

  return (
    <div className="sect-pane">
      <div className="sect-pane-top">
        <div className="sect-pane-title-wrap">
          <div className="sect-title">宗门大厅</div>
        </div>
        <div className="sect-pane-actions">
          <Button type="primary" onClick={onOpenCreate}>
            创建宗门
          </Button>
        </div>
      </div>

      <div className="sect-pane-body">
        <div className="sect-search-bar">
          <Input
            value={searchKeyword}
            onChange={(event) => onSearchKeywordChange(event.target.value)}
            onPressEnter={onSearch}
            placeholder="按宗门名称搜索"
            allowClear
            prefix={<SearchOutlined />}
          />
          <Button onClick={onSearch} loading={listLoading}>
            搜索
          </Button>
        </div>

        {isMobile ? (
          <div className="sect-mobile-list">
            {sects.length === 0 && !listLoading ? <div className="sect-empty">暂无符合条件的宗门</div> : null}
            {sects.map((row) => (
              <div key={row.id} className="sect-mobile-card">
                <div className="sect-mobile-card-head">
                  <div className="sect-mobile-card-title" style={{ fontWeight: 600 }}>{row.name}</div>
                  {renderSectLevelTag(row.level)}
                </div>
                <div className="sect-mobile-meta-line" style={{ display: 'flex', alignItems: 'center', gap: '8px 12px' }}>
                  <span className="sect-mobile-meta-item">
                    <span className="sect-mobile-meta-k">成员</span>
                    {renderMemberCountNode(row.members, row.memberCap)}
                  </span>
                  <span className="sect-mobile-meta-item">
                    <span className="sect-mobile-meta-k">最低境界</span>
                    {renderRealmTag(row.joinMinRealm)}
                  </span>
                </div>
                <div className="sect-mobile-message" style={{ color: row.notice?.trim() ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>
                  {row.notice?.trim() || '暂无宣言'}
                </div>
                <div className="sect-mobile-actions">{renderActionButton(row.id)}</div>
              </div>
            ))}
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => row.id}
            pagination={false}
            loading={listLoading}
            className="sect-table"
            columns={[
              {
                title: '宗门',
                dataIndex: 'name',
                key: 'name',
                width: 180,
                render: (value: string) => (
                  <span
                    style={{
                      fontWeight: 600,
                      color: 'var(--text-color)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {value}
                  </span>
                ),
              },
              {
                title: '等级',
                dataIndex: 'level',
                key: 'level',
                width: 80,
                render: (value: number) => renderSectLevelTag(value),
              },
              {
                title: '成员',
                key: 'members',
                width: 100,
                render: (_: unknown, row: SectListItemVm) => renderMemberCountNode(row.members, row.memberCap),
              },
              {
                title: '最低境界',
                dataIndex: 'joinMinRealm',
                key: 'joinMinRealm',
                width: 100,
                render: (value: string) => renderRealmTag(value),
              },
              {
                title: '宣言',
                dataIndex: 'notice',
                key: 'notice',
                ellipsis: {
                  showTitle: false,
                },
                render: (value: string) => {
                  const content = value?.trim() || '暂无宣言';
                  return (
                    <Tooltip
                      placement="topLeft"
                      title={
                        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxWidth: '280px' }}>
                          {content}
                        </div>
                      }
                    >
                      <span className="sect-table-notice-cell" style={{ color: value?.trim() ? 'var(--text-secondary)' : 'var(--text-tertiary)', cursor: 'pointer' }}>
                        {content}
                      </span>
                    </Tooltip>
                  );
                },
              },
              {
                title: '操作',
                key: 'action',
                width: 120,
                render: (_: unknown, row: SectListItemVm) => renderActionButton(row.id),
              },
            ]}
            dataSource={sects}
            locale={{ emptyText: '暂无符合条件的宗门' }}
          />
        )}
      </div>
    </div>
  );
};

export default NoSectHallPanel;
