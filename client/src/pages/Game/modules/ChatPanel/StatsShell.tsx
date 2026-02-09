import type { ReactNode } from 'react';
import { Drawer, Modal } from 'antd';

interface StatsShellProps {
  title: string;
  open: boolean;
  onClose: () => void;
  isMobile?: boolean;
  children: ReactNode;
}

const StatsShell = ({ title, open, onClose, isMobile, children }: StatsShellProps) => {
  if (isMobile) {
    return (
      <Drawer
        title={title}
        open={open}
        onClose={onClose}
        placement="bottom"
        height="85vh"
        className="chat-stats-drawer"
      >
        {children}
      </Drawer>
    );
  }

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      className="chat-stats-modal"
    >
      {children}
    </Modal>
  );
};

export default StatsShell;
