/**
 * Dry-Run Executor for SoroTask Keeper
 *
 * Simulates task execution locally by building and simulating a Soroban
 * transaction without signing or submitting it to the network.
 *
 * Use this to:
 *  - Validate keeper configuration before going live
 *  - Debug task eligibility and contract calls
 *  - Estimate fees without spending real tokens
 *
 * Usage:
 *   node index.js --dry-run
 */

const {
  Contract,
  xdr,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  rpc: SorobanRpc,
} = require('@stellar/stellar-sdk');
const { createLogger } = require('./logger.js');

const logger = createLogger('dry-run');

/**
 * Simulate a task execution without submitting a transaction.
 *
 * Mirrors the first three steps of executeTask (build → simulate → assemble)
 * then stops. No signing, no network submission, no fees charged.
 *
 * @param {number|bigint} taskId
 * @param {object} deps
 * @param {import('@stellar/stellar-sdk').rpc.Server} deps.server
 * @param {import('@stellar/stellar-sdk').Keypair} deps.keypair
 * @param {import('@stellar/stellar-sdk').Account} deps.account
 * @param {string} deps.contractId
 * @param {string} deps.networkPassphrase
 * @returns {Promise<{taskId, txHash: null, status: string, feePaid: 0, error: string|null, simulation: object|null}>}
 */
async function dryRunTask(taskId, { server, keypair, account, contractId, networkPassphrase }) {
  const result = {
    taskId,
    txHash: null,
    status: 'DRY_RUN_PENDING',
    feePaid: 0,
    error: null,
    simulation: null,
  };

  logger.info('Simulating task — no transaction will be submitted', { taskId });

  try {
    const contract = new Contract(contractId);
    const taskIdScVal = xdr.ScVal.scvU64(xdr.Uint64.fromString(taskId.toString()));

    // ── Step 1: Build ────────────────────────────────────────────────────────
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: networkPassphrase || Networks.FUTURENET,
    })
      .addOperation(contract.call('execute', taskIdScVal))
      .setTimeout(30)
      .build();

    logger.info('Transaction built', {
      taskId,
      keeperAddress: keypair.publicKey(),
      contractId,
      networkPassphrase,
    });

    // ── Step 2: Simulate ─────────────────────────────────────────────────────
    logger.info('Sending simulation request to RPC', { taskId });
    const simResult = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      logger.warn('Simulation returned an error — task would fail on-chain', {
        taskId,
        error: simResult.error,
      });
      result.status = 'DRY_RUN_SIM_FAILED';
      result.error = simResult.error;
      return result;
    }

    // ── Step 3: Assemble (validates footprint, does NOT sign/submit) ─────────
    const assembledTx = SorobanRpc.assembleTransaction(tx, simResult).build();

    const estimatedFee = simResult.minResourceFee
      ? Number(simResult.minResourceFee)
      : 0;

    result.simulation = {
      estimatedFee,
      latestLedger: simResult.latestLedger,
      transactionXdr: assembledTx.toEnvelope().toXDR('base64'),
    };
    result.status = 'DRY_RUN_SUCCESS';

    logger.info('Simulation successful — task is eligible and would execute on-chain', {
      taskId,
      estimatedFee,
      latestLedger: simResult.latestLedger,
    });

    // ── Dry-run boundary — sign & submit are intentionally skipped ───────────
    logger.info('SKIPPING sign, submit, and confirmation (dry-run mode active)', { taskId });

  } catch (err) {
    result.status = 'DRY_RUN_ERROR';
    result.error = err.message || String(err);
    logger.error('Unexpected error during simulation', { taskId, error: result.error });
  }

  return result;
}

module.exports = { dryRunTask };
