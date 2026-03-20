/**
 * 易名符改名弹窗
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：承载“消耗易名符后输入新名称”的唯一表单 UI，供角色改名与伙伴改名共同复用。
 * 2. 做什么：复用统一名字规则，并在打开时自动带入当前名字，减少多个入口重复拼表单。
 * 3. 不做什么：不直接发请求、不刷新背包，也不决定改名成功后的业务副作用。
 *
 * 输入/输出：
 * - 输入：弹窗开关、标题文案、字段文案、初始名字、提交中状态，以及取消/提交回调。
 * - 输出：标准 Ant Design Modal + Form。
 *
 * 数据流/状态流：
 * 外层 flow 提供当前易名符上下文与当前展示名 -> 本组件维护表单输入 -> 提交时把裁剪后的新名称回传给上层。
 *
 * 关键边界条件与坑点：
 * 1. 弹窗每次打开都要重置成最新角色名，否则连续改名时会残留上一次输入。
 * 2. 表单只负责前端格式校验，不能在这里补做敏感词、重名或道具数量规则。
 */
import { Button, Form, Input, Modal, Typography } from 'antd';
import { useEffect } from 'react';

import {
  buildNameFormRules,
  NAME_MAX_LENGTH,
  normalizeCharacterNameInput,
} from './characterNameShared';

interface CharacterRenameModalProps {
  open: boolean;
  title: string;
  itemName: string;
  description: string;
  inputLabel: string;
  inputPlaceholder: string;
  submitText: string;
  initialName: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
}

interface CharacterRenameFormValues {
  name: string;
}

const CharacterRenameModal: React.FC<CharacterRenameModalProps> = ({
  open,
  title,
  itemName,
  description,
  inputLabel,
  inputPlaceholder,
  submitText,
  initialName,
  submitting,
  onCancel,
  onSubmit,
}) => {
  const [form] = Form.useForm<CharacterRenameFormValues>();

  useEffect(() => {
    if (!open) {
      return;
    }
    form.setFieldsValue({
      name: initialName,
    });
  }, [form, initialName, open]);

  const handleFinish = async (values: CharacterRenameFormValues): Promise<void> => {
    await onSubmit(normalizeCharacterNameInput(values.name));
  };

  return (
    <Modal
      open={open}
      title={title}
      onCancel={submitting ? undefined : onCancel}
      footer={null}
      destroyOnHidden
      centered
      width="min(420px, calc(100vw - 24px))"
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          void handleFinish(values);
        }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          {description || `消耗 1 张【${itemName}】后，立即将名称改为新的内容。`}
        </Typography.Paragraph>
        <Form.Item
          name="name"
          label={inputLabel}
          rules={buildNameFormRules({
            requiredMessage: `请输入${inputLabel}`,
            fieldLabel: inputLabel,
          })}
        >
          <Input
            placeholder={inputPlaceholder}
            autoComplete="off"
            maxLength={NAME_MAX_LENGTH}
          />
        </Form.Item>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Button onClick={onCancel} disabled={submitting}>
            取消
          </Button>
          <Button type="primary" htmlType="submit" loading={submitting}>
            {submitText}
          </Button>
        </div>
      </Form>
    </Modal>
  );
};

export default CharacterRenameModal;
