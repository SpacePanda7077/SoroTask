require('dotenv').config();
const { Keypair, rpc, Contract, TransactionBuilder, BASE_FEE, Networks, xdr } = require('@stellar/stellar-sdk');
const { Server } = rpc;

const { loadConfig } = require('./src/config');
const { initializeKeeperAccount } = require('./src/account');
const { ExecutionQueue } = require('./src/queue');
const TaskPoller = require('./src/poller');

async function main() {
    console.log("Starting SoroTask Keeper...");

    let config;
    try {
        config = loadConfig();
        console.log(`Configured for network: ${config.networkPassphrase}`);
        console.log(`RPC URL: ${config.rpcUrl}`);
    } catch (err) {
        console.error(`Configuration error: ${err.message}`);
        process.exit(1);
    }

    let keeperData;
    try {
        keeperData = await initializeKeeperAccount();
    } catch (err) {
        console.error(`Failed to initialize keeper: ${err.message}`);
        process.exit(1);
    }

    const { keypair, accountResponse } = keeperData;
    const server = new Server(config.rpcUrl);

    // Initialize polling engine
    const poller = new TaskPoller(server, config.contractId, {
        maxConcurrentReads: process.env.MAX_CONCURRENT_READS
    });
    console.log(`Poller initialized for contract: ${config.contractId}`);

    // Initialize execution queue
    const queue = new ExecutionQueue();

    queue.on('task:started', (taskId) => console.log(`[Queue] Started execution for task ${taskId}`));
    queue.on('task:success', (taskId) => console.log(`[Queue] Task ${taskId} executed successfully`));
    queue.on('task:failed', (taskId, err) => console.error(`[Queue] Task ${taskId} failed:`, err.message));
    queue.on('cycle:complete', (stats) => console.log(`[Queue] Cycle complete: ${JSON.stringify(stats)}`));

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
            console.log(`[Executor] Task ${taskId} transaction submitted: ${response.hash}`);

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
                    console.log(`[Executor] Task ${taskId} executed successfully`);
                } else {
                    throw new Error(`Transaction failed with status: ${status.status}`);
                }
            }

        } catch (error) {
            console.error(`[Executor] Failed to execute task ${taskId}:`, error.message);
            throw error;
        }
    };

    // Get task registry - in production, this would query the contract for all registered task IDs
    const getTaskRegistry = async () => {
        // Option 1: Use environment variable for known task IDs
        if (process.env.TASK_IDS) {
            return process.env.TASK_IDS.split(',').map(id => parseInt(id.trim(), 10));
        }

        // Option 2: Default range (can be improved by querying events or contract counter)
        try {
            const maxTaskId = parseInt(process.env.MAX_TASK_ID || 10, 10);
            return Array.from({ length: maxTaskId }, (_, i) => i + 1);
        } catch (error) {
            console.warn('[Registry] Could not determine task range');
            return [];
        }
    };

    // Polling loop
    const pollingIntervalMs = config.pollIntervalMs;
    console.log(`Starting polling loop with interval: ${pollingIntervalMs}ms`);

    const pollingInterval = setInterval(async () => {
        try {
            console.log('\n[Keeper] ===== Starting new polling cycle =====');

            // Get list of all registered task IDs
            const taskIds = await getTaskRegistry();
            console.log(`[Keeper] Checking ${taskIds.length} tasks...`);

            // Poll for due tasks
            const dueTaskIds = await poller.pollDueTasks(taskIds);

            if (dueTaskIds.length > 0) {
                console.log(`[Keeper] Found ${dueTaskIds.length} due tasks, enqueueing for execution...`);
                await queue.enqueue(dueTaskIds, executeTask);
            } else {
                console.log('[Keeper] No tasks due for execution');
            }

            console.log('[Keeper] ===== Polling cycle complete =====\n');

        } catch (error) {
            console.error('[Keeper] Error in polling cycle:', error);
        }
    }, pollingIntervalMs);

    // Graceful shutdown handling
    const shutdown = async (signal) => {
        console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
        clearInterval(pollingInterval);
        await queue.drain();
        console.log("Graceful shutdown complete. Exiting.");
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Run first poll immediately
    console.log('[Keeper] Running initial poll...');
    setTimeout(async () => {
        try {
            const taskIds = await getTaskRegistry();
            const dueTaskIds = await poller.pollDueTasks(taskIds);
            if (dueTaskIds.length > 0) {
                await queue.enqueue(dueTaskIds, executeTask);
            }
        } catch (error) {
            console.error('[Keeper] Error in initial poll:', error);
        }
    }, 1000);
}

main().catch((err) => {
    console.error("Fatal Keeper Error:", err);
    process.exit(1);
});
