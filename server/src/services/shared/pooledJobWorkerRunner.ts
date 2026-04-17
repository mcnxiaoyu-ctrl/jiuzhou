import { cpus } from 'os';
import path from 'path';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { createScopedLogger } from '../../utils/logger.js';

/**
 * 通用池化 Worker 调度器
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为“固定脚本、固定消息协议”的后台任务提供有界并发 Worker 池、FIFO 队列、超时与崩溃恢复。
 * 2. 做什么：统一输出队列长度、Worker 启动耗时、任务执行耗时与超时计数日志，避免各 job runner 各写一套池化逻辑。
 * 3. 不做什么：不决定业务失败后的退款/推送策略，不解析领域状态，也不做数据库恢复扫描。
 *
 * 输入 / 输出：
 * - 输入：Worker 脚本路径、并发数、任务超时、协议构造器与响应解析器。
 * - 输出：`initialize / execute / shutdown`；`execute` 返回单个任务的结果 Promise。
 *
 * 数据流 / 状态流：
 * runner.enqueue -> execute 入队 -> 空闲 Worker 分配执行 -> Worker result/error -> Promise settle -> 拉起下一个任务。
 *
 * 复用设计说明：
 * 1. 招募/研修/云游三类 AI 生成任务只有“脚本、消息体、结果处理”不同，池化并发、队列和崩溃恢复完全相同，因此集中成共享调度器最能减少重复。
 * 2. 把高频变动留给具体 runner，只把通用调度协议放在这里，后续增加新的 AI worker 不必再复制一整套池化代码。
 *
 * 关键边界条件与坑点：
 * 1. Worker 脚本必须支持多次执行消息，不能在完成单任务后自行退出，否则池化模型会退化回“一任务一线程”。
 * 2. 超时只会拒绝当前任务，不会强制终止整个进程；若 Worker 已进入异常状态，必须由崩溃恢复逻辑主动替换实例。
 */

type WorkerLifecycleMessage<TResult> =
  | { kind: 'ready' }
  | { kind: 'result'; payload: TResult }
  | { kind: 'error'; message: string; stack?: string };

type QueuedWorkerTask<TPayload, TResult> = {
  jobKey: string;
  payload: TPayload;
  enqueuedAt: number;
  resolve: (value: TResult) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

type WorkerState<TPayload, TResult> = {
  index: number;
  worker: Worker;
  ready: boolean;
  busy: boolean;
  startupStartedAt: number;
  currentTask: QueuedWorkerTask<TPayload, TResult> | null;
  processedTaskCount: number;
};

type PooledJobWorkerRunnerOptions<TPayload, TWorkerMessage, TWorkerResponse, TResult> = {
  label: string;
  workerScript: string;
  workerCount?: number;
  taskTimeoutMs?: number;
  buildExecuteMessage: (payload: TPayload) => TWorkerMessage;
  parseWorkerResponse: (message: TWorkerResponse) => WorkerLifecycleMessage<TResult>;
};

const DEFAULT_TASK_TIMEOUT_MS = 120_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

export class PooledJobWorkerRunner<TPayload, TWorkerMessage, TWorkerResponse, TResult> {
  private readonly logger;
  private readonly options: Required<Omit<PooledJobWorkerRunnerOptions<TPayload, TWorkerMessage, TWorkerResponse, TResult>, 'buildExecuteMessage' | 'parseWorkerResponse'>> & Pick<PooledJobWorkerRunnerOptions<TPayload, TWorkerMessage, TWorkerResponse, TResult>, 'buildExecuteMessage' | 'parseWorkerResponse'>;
  private readonly workers: Array<WorkerState<TPayload, TResult>> = [];
  private readonly taskQueue: Array<QueuedWorkerTask<TPayload, TResult>> = [];
  private readonly activeJobKeys = new Set<string>();
  private initialized = false;
  private shuttingDown = false;
  private nextWorkerIndex = 0;

  constructor(options: PooledJobWorkerRunnerOptions<TPayload, TWorkerMessage, TWorkerResponse, TResult>) {
    const cpuCount = cpus().length;
    this.options = {
      label: options.label,
      workerScript: options.workerScript,
      workerCount: options.workerCount ?? Math.max(1, cpuCount - 1),
      taskTimeoutMs: options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      buildExecuteMessage: options.buildExecuteMessage,
      parseWorkerResponse: options.parseWorkerResponse,
    };
    this.logger = createScopedLogger(`worker.pool.${options.label}`);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    const createTasks = Array.from({ length: this.options.workerCount }, async () => {
      const state = await this.createWorker();
      this.workers.push(state);
    });
    await Promise.all(createTasks);
  }

  async shutdown(timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS): Promise<void> {
    this.shuttingDown = true;
    for (const queuedTask of this.taskQueue.splice(0)) {
      clearTimeout(queuedTask.timeoutHandle);
      this.activeJobKeys.delete(queuedTask.jobKey);
      queuedTask.reject(new Error(`${this.options.label} Worker 池正在关闭`));
    }

    const waitStartedAt = Date.now();
    while (this.workers.some((worker) => worker.busy)) {
      if (Date.now() - waitStartedAt >= timeoutMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const workers = this.workers.splice(0);
    await Promise.allSettled(workers.map(async (state) => {
      try {
        state.worker.postMessage({ type: 'shutdown' } as TWorkerMessage);
      } finally {
        await state.worker.terminate();
      }
    }));
  }

  hasActiveJob(jobKey: string): boolean {
    return this.activeJobKeys.has(jobKey);
  }

  getQueueLength(): number {
    return this.taskQueue.length;
  }

  async execute(jobKey: string, payload: TPayload): Promise<TResult> {
    if (!this.initialized) {
      throw new Error(`${this.options.label} Worker 池尚未初始化`);
    }
    if (this.shuttingDown) {
      throw new Error(`${this.options.label} Worker 池正在关闭`);
    }
    if (this.activeJobKeys.has(jobKey)) {
      throw new Error(`${this.options.label} 任务重复入队: ${jobKey}`);
    }

    this.activeJobKeys.add(jobKey);
    return await new Promise<TResult>((resolve, reject) => {
      const enqueuedAt = Date.now();
      const task: QueuedWorkerTask<TPayload, TResult> = {
        jobKey,
        payload,
        enqueuedAt,
        resolve: (value) => {
          this.activeJobKeys.delete(jobKey);
          resolve(value);
        },
        reject: (error) => {
          this.activeJobKeys.delete(jobKey);
          reject(error);
        },
        timeoutHandle: setTimeout(() => {
          this.handleTaskTimeout(task);
        }, this.options.taskTimeoutMs),
      };

      this.taskQueue.push(task);
      if (this.taskQueue.length > 1) {
        this.logger.info({
          jobKey,
          queue_length: this.taskQueue.length,
        }, 'Worker 任务已入队');
      }
      this.dispatchQueuedTasks();
    });
  }

  private async createWorker(): Promise<WorkerState<TPayload, TResult>> {
    const workerIndex = this.nextWorkerIndex++;
    const startupStartedAt = Date.now();
    const worker = new Worker(this.options.workerScript);
    const state: WorkerState<TPayload, TResult> = {
      index: workerIndex,
      worker,
      ready: false,
      busy: false,
      startupStartedAt,
      currentTask: null,
      processedTaskCount: 0,
    };

    worker.on('message', (message) => {
      this.handleWorkerMessage(state, message as TWorkerResponse);
    });
    worker.on('error', (error: Error) => {
      this.handleWorkerCrash(state, error);
    });
    worker.on('exit', (code) => {
      if (this.shuttingDown || code === 0) {
        return;
      }
      this.handleWorkerCrash(state, new Error(`Worker 异常退出，退出码=${code}`));
    });

    await new Promise<void>((resolve, reject) => {
      let interval: ReturnType<typeof setInterval> | null = null;
      const timer = setTimeout(() => {
        if (interval) {
          clearInterval(interval);
        }
        reject(new Error(`${this.options.label} Worker 启动超时`));
      }, DEFAULT_STARTUP_TIMEOUT_MS);

      interval = setInterval(() => {
        if (!state.ready) {
          return;
        }
        clearInterval(interval!);
        clearTimeout(timer);
        resolve();
      }, 10);
    });

    this.logger.info({
      workerIndex,
      task_startup_ms: Math.max(0, Date.now() - startupStartedAt),
    }, 'Worker 已就绪');
    return state;
  }

  private handleWorkerMessage(
    state: WorkerState<TPayload, TResult>,
    message: TWorkerResponse,
  ): void {
    const lifecycleMessage = this.options.parseWorkerResponse(message);
    if (lifecycleMessage.kind === 'ready') {
      state.ready = true;
      this.dispatchQueuedTasks();
      return;
    }

    const currentTask = state.currentTask;
    if (!currentTask) {
      return;
    }

    clearTimeout(currentTask.timeoutHandle);
    state.currentTask = null;
    state.busy = false;
    state.processedTaskCount += 1;

    if (lifecycleMessage.kind === 'result') {
      const taskExecMs = Math.max(0, Date.now() - currentTask.enqueuedAt);
      if (taskExecMs > 1_000 || this.taskQueue.length > 0) {
        this.logger.info({
          jobKey: currentTask.jobKey,
          task_exec_ms: taskExecMs,
          queue_length: this.taskQueue.length,
        }, 'Worker 任务执行完成');
      }
      currentTask.resolve(lifecycleMessage.payload);
    } else {
      currentTask.reject(new Error(
        lifecycleMessage.stack
          ? `${lifecycleMessage.message}\n${lifecycleMessage.stack}`
          : lifecycleMessage.message,
      ));
    }

    this.dispatchQueuedTasks();
  }

  private handleTaskTimeout(task: QueuedWorkerTask<TPayload, TResult>): void {
    const queueIndex = this.taskQueue.indexOf(task);
    if (queueIndex >= 0) {
      this.taskQueue.splice(queueIndex, 1);
      this.activeJobKeys.delete(task.jobKey);
      task.reject(new Error(`${this.options.label} 任务排队超时`));
      this.logger.warn({
        jobKey: task.jobKey,
        task_timeout_count: 1,
        queue_length: this.taskQueue.length,
      }, 'Worker 任务排队超时');
      return;
    }

    const workerState = this.workers.find((state) => state.currentTask === task);
    if (!workerState) {
      return;
    }

    workerState.currentTask = null;
    workerState.busy = false;
    this.activeJobKeys.delete(task.jobKey);
    task.reject(new Error(`${this.options.label} 任务执行超时`));
    this.logger.warn({
      jobKey: task.jobKey,
      task_timeout_count: 1,
      queue_length: this.taskQueue.length,
    }, 'Worker 任务执行超时');
    this.dispatchQueuedTasks();
  }

  private handleWorkerCrash(
    state: WorkerState<TPayload, TResult>,
    error: Error,
  ): void {
    const currentTask = state.currentTask;
    if (currentTask) {
      clearTimeout(currentTask.timeoutHandle);
      state.currentTask = null;
      state.busy = false;
      this.activeJobKeys.delete(currentTask.jobKey);
      currentTask.reject(error);
    }

    const workerIndex = this.workers.indexOf(state);
    if (workerIndex >= 0) {
      this.workers.splice(workerIndex, 1);
    }

    if (!this.shuttingDown) {
      void this.createWorker()
        .then((nextState) => {
          this.workers.push(nextState);
          this.dispatchQueuedTasks();
        })
        .catch((createError) => {
          this.logger.error(createError, 'Worker 崩溃后重新拉起失败');
        });
    }
    this.logger.error(error, 'Worker 发生崩溃，当前任务已回退');
  }

  private dispatchQueuedTasks(): void {
    while (this.taskQueue.length > 0) {
      const idleWorker = this.workers
        .filter((worker) => worker.ready && !worker.busy)
        .sort((left, right) => left.processedTaskCount - right.processedTaskCount)[0];
      if (!idleWorker) {
        return;
      }

      const nextTask = this.taskQueue.shift();
      if (!nextTask) {
        return;
      }

      idleWorker.busy = true;
      idleWorker.currentTask = nextTask;
      idleWorker.worker.postMessage(this.options.buildExecuteMessage(nextTask.payload));
    }
  }
}

export const resolveWorkerScriptPath = (
  currentImportMetaUrl: string,
  scriptBaseName: string,
): string => {
  const currentFilename = fileURLToPath(currentImportMetaUrl);
  const currentDirname = path.dirname(currentFilename);
  if (process.env.NODE_ENV !== 'production') {
    return path.join(currentDirname, `../../dist/workers/${scriptBaseName}.js`);
  }
  return path.join(currentDirname, `../workers/${scriptBaseName}.js`);
};
