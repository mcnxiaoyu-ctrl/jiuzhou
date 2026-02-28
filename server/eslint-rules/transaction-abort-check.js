/**
 * 自定义 ESLint 规则：检测事务中止错误处理
 *
 * 规则：catch 块必须检查并重新抛出事务中止错误（25P02）
 */

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: '确保 catch 块正确处理事务中止错误',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      missingTransactionAbortCheck: 'catch 块必须检查并重新抛出事务中止错误（error.code === "25P02"）',
    },
    schema: [],
  },

  create(context) {
    return {
      CatchClause(node) {
        const catchBody = node.body;

        // 检查是否是空 catch 块
        if (catchBody.body.length === 0) {
          context.report({
            node,
            messageId: 'missingTransactionAbortCheck',
          });
          return;
        }

        // 检查是否有重新抛出逻辑
        const hasThrow = catchBody.body.some(statement => {
          return statement.type === 'ThrowStatement';
        });

        // 检查是否有 25P02 检查
        const sourceCode = context.getSourceCode();
        const catchText = sourceCode.getText(catchBody);
        const has25P02Check = catchText.includes('25P02') || catchText.includes("'25P02'") || catchText.includes('"25P02"');

        // 如果有 throw 但没有 25P02 检查，可能有问题
        if (!has25P02Check && !hasThrow) {
          // 检查是否在 withTransaction 或 withTransactionAuto 内部
          let parent = node.parent;
          let inTransaction = false;

          while (parent) {
            if (parent.type === 'CallExpression') {
              const callee = parent.callee;
              if (callee.type === 'Identifier' &&
                  (callee.name === 'withTransaction' || callee.name === 'withTransactionAuto')) {
                inTransaction = true;
                break;
              }
            }
            parent = parent.parent;
          }

          if (inTransaction) {
            context.report({
              node,
              messageId: 'missingTransactionAbortCheck',
            });
          }
        }
      },
    };
  },
};
