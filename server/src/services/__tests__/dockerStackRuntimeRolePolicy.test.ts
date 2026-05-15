/**
 * Docker Swarm 运行角色拆分策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 docker-stack.yml 中 API 与 worker 服务的运行角色、镜像、端口和健康检查策略。
 * 2. 做什么：保护 client 到 server:6011 的内部访问路径，避免拆分 worker 时误改前端反代目标。
 * 3. 做什么：确认 worker 通过公共 anchor 继承数据库、Redis、JWT、uploads、网络、停机和重启策略。
 * 4. 不做什么：不启动 Docker Swarm，不解析或部署真实 stack。
 *
 * 输入 / 输出：
 * - 输入：仓库根目录 docker-stack.yml 的源码文本。
 * - 输出：静态断言，确认 server、server_worker、client 以及公共 extension field 满足生产部署约束。
 *
 * 数据流 / 状态流：
 * docker-stack.yml 文本 -> 切出顶层 services 段 -> 按服务名切出服务块 -> 结合公共 anchor 做策略断言。
 *
 * 复用设计说明：
 * - `readTopLevelBlock` 统一切出 services 与 x-* extension field，避免顶层段落边界散落在各条断言里。
 * - `readDockerStackServiceBlock` 只在 services 段内定位服务，避免误把顶层 volumes/configs/networks 当作服务边界。
 * - `readServiceImage` 作为镜像读取入口，可解析直接 image 与 `x-server-common` 继承，避免重复正则。
 * - 运行角色、镜像、端口、healthcheck 和生产配置属于高频部署策略变化点，因此集中在本测试文件内统一约束。
 *
 * 关键边界条件与坑点：
 * 1. 服务块边界必须先受 services 顶层段限制，不能在全文件范围内用两空格缩进推断服务。
 * 2. environment 使用 mapping 才能通过 YAML merge 继承公共变量，list 形式无法可靠合并。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const dockerStackPath = path.resolve(process.cwd(), 'docker-stack.yml');
const dockerStackSource = readFileSync(dockerStackPath, 'utf8');

const escapeRegExp = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');

const readTopLevelBlock = (blockName: string): string => {
  const blockStartPattern = new RegExp(`^${escapeRegExp(blockName)}:\\r?\\n`, 'mu');
  const blockStartMatch = blockStartPattern.exec(dockerStackSource);

  if (blockStartMatch === null) {
    assert.fail(`docker-stack.yml 应包含顶层 ${blockName} 段`);
  }

  const blockStartIndex = blockStartMatch.index;
  const blockBodyStartIndex = blockStartIndex + blockStartMatch[0].length;
  const nextTopLevelMatch = /^[a-zA-Z0-9_-]+:\r?\n/mu.exec(dockerStackSource.slice(blockBodyStartIndex));
  const blockEndIndex =
    nextTopLevelMatch === null ? dockerStackSource.length : blockBodyStartIndex + nextTopLevelMatch.index;

  return dockerStackSource.slice(blockStartIndex, blockEndIndex);
};

const servicesBlock = readTopLevelBlock('services');

const readDockerStackServiceBlock = (serviceName: string): string => {
  const serviceStartPattern = new RegExp(`^  ${escapeRegExp(serviceName)}:\\r?\\n`, 'mu');
  const serviceStartMatch = serviceStartPattern.exec(servicesBlock);

  if (serviceStartMatch === null) {
    assert.fail(`docker-stack.yml 应包含 ${serviceName} 服务`);
  }

  const serviceStartIndex = serviceStartMatch.index;
  const serviceBodyStartIndex = serviceStartIndex + serviceStartMatch[0].length;
  const nextServiceMatch = /^  [a-zA-Z0-9_-]+:\r?\n/mu.exec(servicesBlock.slice(serviceBodyStartIndex));
  const serviceEndIndex =
    nextServiceMatch === null ? servicesBlock.length : serviceBodyStartIndex + nextServiceMatch.index;

  return servicesBlock.slice(serviceStartIndex, serviceEndIndex);
};

const assertServiceBlockContains = (serviceBlock: string, expectedText: string, message: string): void => {
  assert.ok(serviceBlock.includes(expectedText), message);
};

const readServiceImage = (serviceBlock: string, serviceName: string): string => {
  const imageMatch = /^\s+image:\s+(.+)\r?$/mu.exec(serviceBlock);

  if (imageMatch !== null) {
    return imageMatch[1];
  }

  if (serviceBlock.includes('<<: *server-common')) {
    return readServiceImage(readTopLevelBlock('x-server-common'), 'x-server-common');
  }

  assert.fail(`${serviceName} 服务应配置 image 或继承 x-server-common`);
};

test('docker-stack.yml 应保留 API 服务入口与 client 内部访问目标', () => {
  const clientBlock = readDockerStackServiceBlock('client');
  const serverBlock = readDockerStackServiceBlock('server');

  assertServiceBlockContains(
    serverBlock,
    'JIUZHOU_RUNTIME_ROLE: api',
    'server 服务应显式声明 API 运行角色',
  );
  assertServiceBlockContains(serverBlock, '- "6011:6011"', 'server 服务应继续暴露 6011:6011');
  assertServiceBlockContains(serverBlock, 'healthcheck:', 'server 服务应保留 HTTP healthcheck');
  assertServiceBlockContains(
    serverBlock,
    'localhost:6011/api/health',
    'server 服务 healthcheck 应检查本地 API 健康端点',
  );
  assertServiceBlockContains(clientBlock, '- API_HOST=server:6011', 'client 应继续通过 server:6011 访问 API');
});

test('docker-stack.yml 应将后台 worker 独立为无 HTTP 入口服务', () => {
  const serverBlock = readDockerStackServiceBlock('server');
  const serverWorkerBlock = readDockerStackServiceBlock('server_worker');

  assertServiceBlockContains(serverBlock, '<<: *server-common', 'server 应继承服务公共配置');
  assertServiceBlockContains(serverWorkerBlock, '<<: *server-common', 'server_worker 应继承服务公共配置');
  assert.equal(
    readServiceImage(serverWorkerBlock, 'server_worker'),
    readServiceImage(serverBlock, 'server'),
    'server_worker 应与 server 使用同一个镜像',
  );
  assertServiceBlockContains(
    serverWorkerBlock,
    'JIUZHOU_RUNTIME_ROLE: worker',
    'server_worker 服务应显式声明 worker 运行角色',
  );
  assert.doesNotMatch(serverWorkerBlock, /^\s+ports:\r?$/mu, 'server_worker 不应暴露端口');
  assert.doesNotMatch(serverWorkerBlock, /^\s+healthcheck:\r?$/mu, 'server_worker 不应配置 healthcheck');
  assert.doesNotMatch(
    serverWorkerBlock,
    /localhost:6011\/api\/health/u,
    'server_worker 不应配置依赖 HTTP API 的 healthcheck',
  );
});

test('docker-stack.yml 应保留 worker 生产运行配置', () => {
  const serverWorkerBlock = readDockerStackServiceBlock('server_worker');
  const serverCommonBlock = readTopLevelBlock('x-server-common');
  const serverEnvironmentBaseBlock = readTopLevelBlock('x-server-environment-base');

  assertServiceBlockContains(
    serverWorkerBlock,
    '<<: *server-environment-base',
    'server_worker 应继承公共环境变量',
  );
  assertServiceBlockContains(serverEnvironmentBaseBlock, 'DB_HOST: postgres', 'server_worker 应连接 postgres 服务');
  assertServiceBlockContains(
    serverEnvironmentBaseBlock,
    'DATABASE_URL: "postgresql://postgres:',
    'server_worker 应配置 PostgreSQL DATABASE_URL',
  );
  assertServiceBlockContains(
    serverEnvironmentBaseBlock,
    'REDIS_URL: "redis://redis:6379"',
    'server_worker 应连接 redis 服务',
  );
  assertServiceBlockContains(
    serverEnvironmentBaseBlock,
    'JWT_SECRET: "${JWT_SECRET:-change-me-in-production}"',
    'server_worker 应配置 JWT_SECRET',
  );
  assertServiceBlockContains(serverEnvironmentBaseBlock, 'PORT: "6011"', 'server_worker 应保留运行端口环境变量');
  assertServiceBlockContains(
    serverEnvironmentBaseBlock,
    'IDLE_WORKER_COUNT: "${IDLE_WORKER_COUNT:-12}"',
    'server_worker 应配置挂机 worker 数量',
  );
  assertServiceBlockContains(serverCommonBlock, '- uploads:/app/server/uploads', 'server_worker 应挂载 uploads 数据卷');
  assertServiceBlockContains(serverCommonBlock, '- jiuzhou_net', 'server_worker 应加入 jiuzhou_net 网络');
  assertServiceBlockContains(
    serverCommonBlock,
    'stop_grace_period: 30s',
    'server_worker 应配置 30 秒优雅停机窗口',
  );
  assertServiceBlockContains(serverCommonBlock, 'deploy:', 'server_worker 应继承 deploy 配置');
  assertServiceBlockContains(serverCommonBlock, 'restart_policy:', 'server_worker 应配置 deploy.restart_policy');
  assertServiceBlockContains(serverCommonBlock, 'condition: on-failure', 'server_worker 失败时应自动重启');
  assertServiceBlockContains(serverCommonBlock, 'max_attempts: 5', 'server_worker 重启次数应锁定为 5');
});
