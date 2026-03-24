require('dotenv').config();
const { Keypair, rpc, Contract, TransactionBuilder, BASE_FEE, Networks, xdr } = require('@stellar/stellar-sdk');
const { Server } = rpc;

const { loadConfig } = require('./src/config');
const { initializeKeeperAccount } = require('./src/account');
const { ExecutionQueue } = require('./src/queue');
const TaskPoller = require('./src/poller');
const TaskRegistry = require('./src/registry');
const { createLogger } = require('./src/logger');

// Create root logger for the main module
const logger = createLogger('keeper');

async function main() {
    logger.info('Starting SoroTask Keeper');

    let config;
    try {
        config = loadConfig();
        logger.info('Configuration loaded', { 
            network: config.networkPassphrase,
            rpcUrl: config.rpcUrl 
        });
    } catch (err) {
        logger.error('Configuration error', { error: err.message });
        process.exit(1);
    }

    let keeperData;
    try {
        keeperData = await initializeKeeperAccount();
    } catch (err) {
        logger.error('Failed to initialize keeper', { error: err.message });
        process.exit(1);
    }

    const { keypair, accountResponse } = keeperData;
    const server = new Server(config.rpcUrl);

    // Initialize polling engine with logger
    const poller = new TaskPoller(server, config.contractId, {
        maxConcurrentReads: process.env.MAX_CONCURRENT_READS,
        logger: createLogger('poller')
    });
    logger.info('Poller initialized', { contractId: config.contractId });

    // Initialize execution queue
    const queue = new ExecutionQueue();
    const queueLogger = createLogger('queue');

    queue.on('task:started', (taskId) => queueLogger.info('Started execution', { taskId }));
    queue.on('task:success', (taskId) => queueLogger.info('Task executed successfully', { taskId }));
    queue.on('task:failed', (taskId, err) => queueLogger.error('Task failed', { taskId, error: err.message }));
    queue.on('cycle:complete', (stats) => queueLogger.info('Cycle complete', stats));

    // Task executor function - calls contract.execute(keeper, task_id)
    const executeTask = async (taskId) => {
        try {
            // Build the execute transaction
            const contract = new Contract(config.contractId);
            const account = await server.getAccount(keypair.publicKey());

            const operation = contract.call(
                'execute',
                keypair.publicKey(), // keeper address
                taskId // task_id
            );

            const transaction = new TransactionBuilder(account, {
                fee: BASE_FEE,
                networkPassphrase: config.networkPassphrase || Networks.FUTURENET
            })
                .addOperation(operation)
                .setTimeout(30)
                .build();

            transaction.sign(keypair);

            // Submit the transaction
            const response = await server.sendTransaction(transaction);
            logger.info('Task transaction submitted', { taskId, hash: response.hash });

            // Wait for confirmation (optional, can be made configurable)
            if (process.env.WAIT_FOR_CONFIRMATION !== 'false') {
                let status = await server.getTransaction(response.hash);
                let attempts = 0;
                const maxAttempts = 10;

                while (status.status === 'PENDING' && attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    status = await server.getTransaction(response.hash);
                    attempts++;
                }

                if (status.status === 'SUCCESS') {
                    logger.info('Task executed successfully', { taskId });
                } else {
                    throw new Error(`Transaction failed with status: ${status.status}`);
                }
            }

        } catch (error) {
            logger.error('Failed to execute task', { taskId, error: error.message });
            throw error;
        }
    };

    // Initialize event-driven task registry
    const registry = new TaskRegistry(server, config.contractId, {
        startLedger: parseInt(process.env.START_LEDGER || '0', 10),
        logger: createLogger('registry')
    });
    await registry.init();

    // Polling loop
    const pollingIntervalMs = config.pollIntervalMs;
    logger.info('Starting polling loop', { intervalMs: pollingIntervalMs });

    const pollingInterval = setInterval(async () => {
        try {
            logger.info('Starting new polling cycle');

            // Poll for new TaskRegistered events
            await registry.poll();

            // Get list of all registered task IDs
            const taskIds = registry.getTaskIds();
            logger.info('Checking tasks', { taskCount: taskIds.length });

            // Poll for due tasks
            const dueTaskIds = await poller.pollDueTasks(taskIds);

            if (dueTaskIds.length > 0) {
                logger.info('Found due tasks, enqueueing for execution', { dueCount: dueTaskIds.length });
                await queue.enqueue(dueTaskIds, executeTask);
            } else {
                logger.info('No tasks due for execution');
            }

            logger.info('Polling cycle complete');

        } catch (error) {
            logger.error('Error in polling cycle', { error: error.message });
        }
    }, pollingIntervalMs);

    // Graceful shutdown handling
    const shutdown = async (signal) => {
        logger.info('Received shutdown signal, starting graceful shutdown', { signal });
        clearInterval(pollingInterval);
        await queue.drain();
        logger.info('Graceful shutdown complete, exiting');
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Run first poll immediately
    logger.info('Running initial poll');
    setTimeout(async () => {
        try {
            const taskIds = registry.getTaskIds();
            const dueTaskIds = await poller.pollDueTasks(taskIds);
            if (dueTaskIds.length > 0) {
                await queue.enqueue(dueTaskIds, executeTask);
            }
        } catch (error) {
            logger.error('Error in initial poll', { error: error.message });
        }
    }, 1000);
}

main().catch((err) => {
    logger.fatal('Fatal Keeper Error', { error: err.message, stack: err.stack });
    process.exit(1);
});
