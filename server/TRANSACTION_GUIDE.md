# 事务管理指南

## 概述

本项目使用智能事务管理系统，自动处理嵌套事务场景，避免事务中止错误。

## 核心 API

### `withTransactionAuto(callback)`

**推荐使用**：适用于可能被独立调用或嵌套调用的服务函数。

```typescript
export const updateAchievementProgress = async (...) => {
  return await withTransactionAuto(async (client) => {
    // 业务逻辑
    await client.query('UPDATE ...');
  });
};
```

**特性：**
- ✅ 自动检测是否已在事务中
- ✅ 如果已在事务中，直接使用现有连接（避免 SAVEPOINT）
- ✅ 如果不在事务中，创建新事务
- ✅ 错误自动传播

### `withTransaction(callback)`

**传统方式**：适用于明确需要创建新事务的场景。

```typescript
export const distributeBattleRewards = async (...) => {
  return await withTransaction(async (client) => {
    // 业务逻辑
  });
};
```

**特性：**
- 总是创建新事务
- 如果已在事务中，创建 SAVEPOINT（嵌套事务）

## 使用指南

### 1. 服务函数应该使用 `withTransactionAuto`

```typescript
// ✅ 推荐
export const updateUserData = async (userId: number, data: any) => {
  return await withTransactionAuto(async (client) => {
    await client.query('UPDATE users SET ... WHERE id = $1', [userId]);
  });
};
```

### 2. 路由处理器使用 `withTransaction`

```typescript
// ✅ 路由层创建事务
app.post('/api/battle/finish', async (req, res) => {
  try {
    const result = await withTransaction(async (client) => {
      await finishBattle(battleId, client);
      await distributeBattleRewards(monsters, participants, client);
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});
```

### 3. 嵌套调用自动处理

```typescript
// 外层创建事务
await withTransaction(async (client) => {
  // 内层自动使用现有连接（不创建 SAVEPOINT）
  await updateAchievementProgress(characterId, 'kill:monster:1', 1);
  await updateSectionProgress(characterId, { type: 'kill_monster', ... });
});
```

## 错误处理

### 永远不要使用空 catch 块

```typescript
// ❌ 错误：完全吞噬错误
try {
  await someOperation();
} catch {}

// ✅ 正确：至少检查事务中止错误
try {
  await someOperation();
} catch (error) {
  // 事务中止错误必须重新抛出
  if (error?.code === '25P02') {
    throw error;
  }
  // 其他错误可以记录
  console.warn('操作失败:', error);
}
```

### 事务中止错误（25P02）

当事务中的某个 SQL 失败时，PostgreSQL 会将事务标记为中止状态。此时：

1. 所有后续 SQL 都会失败并抛出 `25P02` 错误
2. 必须 ROLLBACK 才能恢复
3. **错误必须向上传播**，不能被吞噬

```typescript
// ✅ 正确处理
try {
  await withTransactionAuto(async (client) => {
    await client.query('INSERT INTO ...'); // 可能失败
    await client.query('UPDATE ...'); // 如果上面失败，这里会抛出 25P02
  });
} catch (error) {
  if (error?.code === '25P02') {
    throw error; // 必须重新抛出
  }
  console.error('操作失败:', error);
}
```

## 迁移指南

### 从 `withTransaction` 迁移到 `withTransactionAuto`

1. 找到使用 `withTransaction` 的服务函数
2. 将 `withTransaction` 替换为 `withTransactionAuto`
3. 更新导入语句

```typescript
// 修改前
import { withTransaction } from '../config/database.js';

export const myFunction = async (...) => {
  return await withTransaction(async (client) => {
    // ...
  });
};

// 修改后
import { withTransactionAuto } from '../config/database.js';

export const myFunction = async (...) => {
  return await withTransactionAuto(async (client) => {
    // ...
  });
};
```

## 自动检查

### Git Pre-commit Hook

项目配置了 pre-commit hook，会自动检查：

- ❌ 空 catch 块
- ⚠️  可能应该使用 `withTransactionAuto` 的地方

如果检查失败，提交会被阻止。

### ESLint 规则

配置了 ESLint 规则来防止：

- 空 catch 块（`no-empty`）
- 未使用的变量（`no-unused-vars`）

## 最佳实践

### ✅ DO

- 使用 `withTransactionAuto` 处理可能被嵌套调用的函数
- 检查并重新抛出事务中止错误（25P02）
- 在最外层（路由）统一处理错误
- 记录有意义的错误信息

### ❌ DON'T

- 不要使用空 catch 块
- 不要吞噬事务中止错误
- 不要在循环中创建事务
- 不要在事务中执行长时间操作（避免锁等待）

## 故障排查

### 问题：事务中止错误（25P02）

**症状：**
```
Error: current transaction is aborted, commands ignored until end of transaction block
```

**原因：**
1. 内层事务失败
2. 错误被 catch 块吞噬
3. 外层继续使用已中止的连接

**解决：**
检查所有 catch 块，确保重新抛出 25P02 错误。

### 问题：双重释放错误

**症状：**
```
Error: Release called on client which has already been released to the pool
```

**原因：**
连接被释放了两次。

**解决：**
已在 `database.ts` 中修复，确保使用最新版本。

## 参考资料

- [TRANSACTION_REFACTOR_PLAN.md](./TRANSACTION_REFACTOR_PLAN.md) - 完整的重构方案
- [PostgreSQL 事务文档](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [Node.js AsyncLocalStorage](https://nodejs.org/api/async_context.html)
