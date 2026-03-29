#!/usr/bin/env node

const {
  MockSorobanRpcServer,
  DEFAULT_NETWORK_PASSPHRASE,
} = require('./src/mockRpcServer');

async function main() {
  const server = new MockSorobanRpcServer({
    host: process.env.MOCK_SOROBAN_RPC_HOST,
    port: process.env.MOCK_SOROBAN_RPC_PORT
      ? Number(process.env.MOCK_SOROBAN_RPC_PORT)
      : undefined,
    networkPassphrase:
      process.env.NETWORK_PASSPHRASE ?? DEFAULT_NETWORK_PASSPHRASE,
    latestLedger: process.env.MOCK_SOROBAN_LEDGER_SEQUENCE
      ? { sequence: Number(process.env.MOCK_SOROBAN_LEDGER_SEQUENCE) }
      : undefined,
  });

  server.setAccount(
    'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    { sequence: '1' },
  );

  const url = await server.start();

  console.log(`Mock Soroban RPC listening on ${url}`);
  console.log(
    'Supported methods: getHealth, getNetwork, getLatestLedger, getEvents, getAccount, simulateTransaction',
  );

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
