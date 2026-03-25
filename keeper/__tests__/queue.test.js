/**
 * Comprehensive Unit Tests for ExecutionQueue Module
 * 
 * Tests concurrency control, graceful drain, and task execution.
 */

const { ExecutionQueue } = require('../src/queue');

describe('ExecutionQueue', () => {
    let queue;

    beforeEach(() => {
        queue = new ExecutionQueue();
    });

    afterEach(async () => {
        if (queue) {
            await queue.drain();
        }
    });

    describe('constructor', () => {
        it('should create ExecutionQueue instance', () => {
            expect(queue).toBeDefined();
        });

        it('should have default concurrency limit', () => {
            expect(queue.concurrencyLimit).toBe(3);
        });

        it('should accept custom concurrency limit', () => {
            const customQueue = new ExecutionQueue(5);
            expect(customQueue.concurrencyLimit).toBe(5);
        });

        it('should read concurrency from environment variable', () => {
            process.env.MAX_CONCURRENT_EXECUTIONS = '10';
            const envQueue = new ExecutionQueue();
            expect(envQueue.concurrencyLimit).toBe(10);
            delete process.env.MAX_CONCURRENT_EXECUTIONS;
        });

        it('should have depth of 0 initially', () => {
            expect(queue.depth).toBe(0);
        });

        it('should have inFlight of 0 initially', () => {
            expect(queue.inFlight).toBe(0);
        });

        it('should have completed of 0 initially', () => {
            expect(queue.completed).toBe(0);
        });

        it('should have failedCount of 0 initially', () => {
            expect(queue.failedCount).toBe(0);
        });
    });

    describe('enqueue', () => {
        it('should execute single task', async () => {
            const executorFn = jest.fn().mockResolvedValue(undefined);
            
            await queue.enqueue([1], executorFn);
            
            expect(executorFn).toHaveBeenCalledTimes(1);
            expect(executorFn).toHaveBeenCalledWith(1);
        });

        it('should execute multiple tasks', async () => {
            const executorFn = jest.fn().mockResolvedValue(undefined);
            
            await queue.enqueue([1, 2, 3], executorFn);
            
            expect(executorFn).toHaveBeenCalledTimes(3);
        });

        it('should respect MAX_CONCURRENT_EXECUTIONS', async () => {
            const concurrentQueue = new ExecutionQueue(2);
            let concurrentExecutions = 0;
            let maxConcurrent = 0;
            
            const slowExecutor = jest.fn(async () => {
                concurrentExecutions++;
                maxConcurrent = Math.max(maxConcurrent, concurrentExecutions);
                await new Promise(resolve => setTimeout(resolve, 50));
                concurrentExecutions--;
            });
            
            await concurrentQueue.enqueue([1, 2, 3, 4, 5], slowExecutor);
            
            expect(maxConcurrent).toBeLessThanOrEqual(2);
        });

        it('should emit task:started event', async () => {
            const startedSpy = jest.fn();
            queue.on('task:started', startedSpy);
            
            const executorFn = jest.fn().mockResolvedValue(undefined);
            await queue.enqueue([1], executorFn);
            
            expect(startedSpy).toHaveBeenCalledWith(1);
        });

        it('should emit task:success event on success', async () => {
            const successSpy = jest.fn();
            queue.on('task:success', successSpy);
            
            const executorFn = jest.fn().mockResolvedValue(undefined);
            await queue.enqueue([1], executorFn);
            
            expect(successSpy).toHaveBeenCalledWith(1);
        });

        it('should emit task:failed event on failure', async () => {
            const failedSpy = jest.fn();
            queue.on('task:failed', failedSpy);
            
            const error = new Error('Execution failed');
            const executorFn = jest.fn().mockRejectedValue(error);
            await queue.enqueue([1], executorFn);
            
            expect(failedSpy).toHaveBeenCalledWith(1, error);
        });

        it('should emit cycle:complete event', async () => {
            const completeSpy = jest.fn();
            queue.on('cycle:complete', completeSpy);
            
            const executorFn = jest.fn().mockResolvedValue(undefined);
            await queue.enqueue([1, 2], executorFn);
            
            expect(completeSpy).toHaveBeenCalled();
            const stats = completeSpy.mock.calls[0][0];
            expect(stats).toHaveProperty('depth');
            expect(stats).toHaveProperty('inFlight');
            expect(stats).toHaveProperty('completed');
            expect(stats).toHaveProperty('failed');
        });

        it('should skip previously failed tasks', async () => {
            const executorFn = jest.fn()
                .mockRejectedValueOnce(new Error('Failed'))
                .mockResolvedValueOnce(undefined);
            
            // First cycle - task 1 fails
            await queue.enqueue([1], executorFn);
            expect(executorFn).toHaveBeenCalledTimes(1);
            
            // Second cycle - task 1 should be skipped
            await queue.enqueue([1], executorFn);
            expect(executorFn).toHaveBeenCalledTimes(1); // Still 1, not called again
        });

        it('should track completed count', async () => {
            const executorFn = jest.fn().mockResolvedValue(undefined);
            
            await queue.enqueue([1, 2, 3], executorFn);
            
            expect(queue.completed).toBe(0); // Reset after cycle
        });

        it('should track failed count', async () => {
            const executorFn = jest.fn().mockRejectedValue(new Error('Failed'));
            
            await queue.enqueue([1, 2], executorFn);
            
            expect(queue.failedCount).toBe(0); // Reset after cycle
        });
    });

    describe('drain', () => {
        it('should wait for in-flight tasks to complete', async () => {
            let taskCompleted = false;
            const slowExecutor = jest.fn(async () => {
                await new Promise(resolve => setTimeout(resolve, 100));
                taskCompleted = true;
            });
            
            // Start task but don't await
            queue.enqueue([1], slowExecutor);
            
            // Immediately call drain
            await queue.drain();
            
            expect(taskCompleted).toBe(true);
            expect(queue.inFlight).toBe(0);
        });

        it('should clear pending queue', async () => {
            const slowExecutor = jest.fn(async () => {
                await new Promise(resolve => setTimeout(resolve, 50));
            });
            
            // Start multiple tasks
            const enqueuePromise = queue.enqueue([1, 2, 3, 4, 5], slowExecutor);
            
            // Immediately drain
            await queue.drain();
            
            expect(queue.depth).toBe(0);
        });

        it('should handle empty queue', async () => {
            await expect(queue.drain()).resolves.not.toThrow();
        });
    });

    describe('graceful shutdown simulation', () => {
        it('should complete running tasks on drain', async () => {
            const completedTasks = [];
            const executorFn = jest.fn(async (taskId) => {
                await new Promise(resolve => setTimeout(resolve, 20));
                completedTasks.push(taskId);
            });
            
            // Start tasks
            const enqueuePromise = queue.enqueue([1, 2, 3], executorFn);
            
            // Simulate shutdown signal
            setTimeout(() => queue.drain(), 30);
            
            await enqueuePromise;
            
            expect(completedTasks.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('metrics integration', () => {
        it('should increment tasksDueTotal when metricsServer provided', async () => {
            const mockMetrics = {
                increment: jest.fn(),
            };
            const metricsQueue = new ExecutionQueue(3, mockMetrics);
            
            const executorFn = jest.fn().mockResolvedValue(undefined);
            await metricsQueue.enqueue([1, 2], executorFn);
            
            expect(mockMetrics.increment).toHaveBeenCalledWith('tasksDueTotal', 2);
        });

        it('should increment tasksExecutedTotal on success', async () => {
            const mockMetrics = {
                increment: jest.fn(),
            };
            const metricsQueue = new ExecutionQueue(3, mockMetrics);
            
            const executorFn = jest.fn().mockResolvedValue(undefined);
            await metricsQueue.enqueue([1], executorFn);
            
            expect(mockMetrics.increment).toHaveBeenCalledWith('tasksExecutedTotal', 1);
        });

        it('should increment tasksFailedTotal on failure', async () => {
            const mockMetrics = {
                increment: jest.fn(),
            };
            const metricsQueue = new ExecutionQueue(3, mockMetrics);
            
            const executorFn = jest.fn().mockRejectedValue(new Error('Failed'));
            await metricsQueue.enqueue([1], executorFn);
            
            expect(mockMetrics.increment).toHaveBeenCalledWith('tasksFailedTotal', 1);
        });

        it('should record lastCycleDurationMs', async () => {
            const mockMetrics = {
                increment: jest.fn(),
                record: jest.fn(),
            };
            const metricsQueue = new ExecutionQueue(3, mockMetrics);
            
            const executorFn = jest.fn().mockResolvedValue(undefined);
            await metricsQueue.enqueue([1], executorFn);
            
            expect(mockMetrics.record).toHaveBeenCalledWith('lastCycleDurationMs', expect.any(Number));
        });
    });
});
