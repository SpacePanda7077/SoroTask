const {
  Contract,
  xdr,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  rpc: SorobanRpc,
} = require('@stellar/stellar-sdk');
const { withRetry, ErrorClassification } = require('./retry.js');
const { createLogger } = require('./logger.js');

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2000;

const logger = createLogger('executor');

/**
 * Poll getTransaction() until SUCCESS or FAILED, or max attempts reached.
 * @param {SorobanRpc.Server} server
 * @param {string} txHash
 * @returns {Promise<{status: string, feePaid: number}>}
 */
async function pollTransaction(server, txHash) {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const response = await server.getTransaction(txHash);

    if (response.status === SorobanRpc.GetTransactionStatus.SUCCESS) {
      const feePaid = response.resultMetaXdr
        ? Number(response.resultMetaXdr?.v3?.()?.sorobanMeta?.()?.ext?.()?.v1?.()?.totalNonRefundableResourceFeeCharged?.()) || 0
        : 0;
      return { status: 'SUCCESS', feePaid };
    }

    if (response.status === SorobanRpc.GetTransactionStatus.FAILED) {
      return { status: 'FAILED', feePaid: 0 };
    }

    // NOT_FOUND means still pending — wait and retry
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { status: 'TIMEOUT', feePaid: 0 };
}

/**
 * Build, simulate, sign, submit, and poll an execute(task_id) Soroban transaction.
 *
 * @param {number|bigint} taskId
 * @param {object} deps
 * @param {SorobanRpc.Server} deps.server
 * @param {import('@stellar/stellar-sdk').Keypair} deps.keypair
 * @param {import('@stellar/stellar-sdk').Account} deps.account  - fresh Account for sequence tracking
 * @param {string} deps.contractId
 * @param {string} deps.networkPassphrase
 * @returns {Promise<{taskId, txHash: string|null, status: string, feePaid: number, error: string|null}>}
 */
async function executeTask(taskId, { server, keypair, account, contractId, networkPassphrase }) {
  /** @type {{taskId, txHash: string|null, status: string, feePaid: number, error: string|null}} */
  const result = { taskId, txHash: null, status: 'PENDING', feePaid: 0, error: null };

  try {
    const contract = new Contract(contractId);
    const taskIdScVal = xdr.ScVal.scvU64(xdr.Uint64.fromString(taskId.toString()));

    // 1. Build transaction
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: networkPassphrase || Networks.FUTURENET,
    })
      .addOperation(contract.call('execute', taskIdScVal))
      .setTimeout(30)
      .build();

    // 2. Simulate to get footprint + resource fees
    const simResult = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw Object.assign(new Error(`Simulation failed: ${simResult.error}`), { code: 'INVALID_ARGS' });
    }

    // 3. Apply simulation result (sets footprint and resource fee)
    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();

    // 4. Sign
    preparedTx.sign(keypair);

    // 5. Submit
    const sendResult = await server.sendTransaction(preparedTx);
    result.txHash = sendResult.hash;

    logger.info('Transaction submitted', { taskId, txHash: sendResult.hash, status: sendResult.status });

    if (sendResult.status === 'ERROR') {
      throw Object.assign(new Error(`Send failed: ${sendResult.errorResult}`), { code: 'INVALID_TRANSACTION' });
    }

    // 6. Poll for final status
    const { status, feePaid } = await pollTransaction(server, sendResult.hash);
    result.status = status;
    result.feePaid = feePaid;

    logger.info('Transaction finalised', { taskId, txHash: result.txHash, status, feePaid });
  } catch (err) {
    result.status = 'FAILED';
    result.error = err.message || String(err);
    logger.error('executeTask failed', { taskId, txHash: result.txHash, error: result.error });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Legacy factory kept for backward-compat with existing tests / consumers
// ---------------------------------------------------------------------------

function createExecutor({ logger: customLogger, config } = {}) {
  const executorLogger = customLogger || createLogger('executor');
  return {
    async execute(task) {
      const retryCount = { value: 0 };

      const retryResult = await withRetry(
        async () => {
          executorLogger.info('Executing task', { task, attempt: retryCount.value + 1 });
          return { taskId: task.id, status: 'executed' };
        },
        {
          maxRetries: config?.maxRetries || 3,
          baseDelayMs: config?.retryBaseDelayMs || 1000,
          maxDelayMs: config?.maxRetryDelayMs || 30000,
          onRetry: (error, attempt, delay) => {
            retryCount.value = attempt;
            executorLogger.info('Retrying task execution', {
              taskId: task.id, attempt, delay, error: error.message || error.code,
            });
          },
          onMaxRetries: (error, attempts) => {
            executorLogger.warn('MAX_RETRIES_EXCEEDED', {
              taskId: task.id, attempts, error: error.message || error.code,
            });
          },
          onDuplicate: () => {
            executorLogger.info('Transaction already accepted (duplicate)', { taskId: task.id });
          },
        }
      );

      if (retryResult.success) {
        executorLogger.info('Task execution completed', {
          taskId: task.id,
          attempts: retryResult.attempts,
          retries: retryResult.retries,
          duplicate: retryResult.duplicate || false,
        });
      }

      return retryResult;
    },
  };
}

module.exports = { executeTask, createExecutor, ErrorClassification };
