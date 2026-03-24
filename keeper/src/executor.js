const { withRetry, ErrorClassification } = require('./retry.js');
const { createLogger } = require('./logger.js');

/**
 * Create an executor for task execution with retry logic
 * @param {Object} deps - Dependencies
 * @param {Object} deps.logger - Logger instance
 * @param {Object} deps.config - Configuration object with retry settings
 * @returns {Object} - Executor instance
 */
function createExecutor({ logger, config }) {
  // Use provided logger or create default
  const executorLogger = logger || createLogger('executor');
  return {
    async execute(task) {
      const retryCount = { value: 0 };

      const result = await withRetry(
        async () => {
          executorLogger.info("Executing task", { task, attempt: retryCount.value + 1 });
          // TODO: build and submit Soroban transaction
          // For now, this is a placeholder that will be replaced with actual implementation
          return { taskId: task.id, status: "executed" };
        },
        {
          maxRetries: config?.maxRetries || 3,
          baseDelayMs: config?.retryBaseDelayMs || 1000,
          maxDelayMs: config?.maxRetryDelayMs || 30000,
          onRetry: (error, attempt, delay) => {
            retryCount.value = attempt;
            executorLogger.info("Retrying task execution", {
              taskId: task.id,
              attempt,
              delay,
              error: error.message || error.code,
            });
          },
          onMaxRetries: (error, attempts) => {
            executorLogger.warn("MAX_RETRIES_EXCEEDED", {
              taskId: task.id,
              attempts,
              error: error.message || error.code,
            });
          },
          onDuplicate: () => {
            executorLogger.info("Transaction already accepted (duplicate)", {
              taskId: task.id,
            });
          },
        }
      );

      // Log execution result with retry count
      if (result.success) {
        executorLogger.info("Task execution completed", {
          taskId: task.id,
          attempts: result.attempts,
          retries: result.retries,
          duplicate: result.duplicate || false,
        });
      }

      return result;
    },
  };
}

// Re-export error classification for consumers
module.exports = { createExecutor, ErrorClassification };
