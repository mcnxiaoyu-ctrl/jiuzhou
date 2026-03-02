import { Avatar, Button, Tag } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { resolveAvatarUrl } from '../../../../services/api';
import './index.scss';

export type TeamMember = {
  id: string;
  name: string;
  title?: string;
  realm?: string;
  avatar?: string | null;
  online?: boolean;
  hp: number;
  maxHp: number;
  qi: number;
  maxQi: number;
  role?: 'leader' | 'member';
};

interface TeamPanelProps {
  members: TeamMember[];
  onSelectMember?: (member: TeamMember) => void;
  onLeaveTeam?: () => void;
}

const TeamPanel: React.FC<TeamPanelProps> = ({ members, onSelectMember, onLeaveTeam }) => {
  const list = (members ?? []).slice().sort((a, b) => {
    const ar = a.role === 'leader' ? 0 : 1;
    const br = b.role === 'leader' ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name, 'zh');
  });
  return (
    <div className="team-panel">
      <div className="team-panel-header">
        <div className="team-panel-title">队伍</div>
        <div className="team-panel-actions">
          <div className="team-panel-count">{list.length}人</div>
          <Button size="small" danger onClick={onLeaveTeam} disabled={!onLeaveTeam}>
            离队
          </Button>
        </div>
      </div>
      <div className="team-panel-body">
        <div className="team-member-list">
          {list.map((m) => {
            const online = m.online === true;
            return (
            <div
              key={m.id}
              className={`team-member${online ? '' : ' is-offline'}`}
              role={onSelectMember ? 'button' : undefined}
              tabIndex={onSelectMember ? 0 : -1}
              onClick={() => onSelectMember?.(m)}
              onKeyDown={(e) => {
                if (!onSelectMember) return;
                if (e.key === 'Enter' || e.key === ' ') onSelectMember(m);
              }}
            >
              <Avatar className="team-member-avatar" size={30} src={resolveAvatarUrl(m.avatar)} icon={<UserOutlined />} />
              <div className="team-member-name" title={m.name}>
                {m.name}
              </div>
              {m.role === 'leader' ? <Tag color="gold">队长</Tag> : null}
              <Tag color={online ? 'green' : 'default'}>{online ? '在线' : '离线'}</Tag>
            </div>
            );
          })}
          {list.length === 0 ? <div className="team-empty">暂无队伍成员</div> : null}
        </div>
      </div>
    </div>
  );
};

export default TeamPanel;
