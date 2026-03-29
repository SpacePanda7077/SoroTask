# Mock Soroban RPC for Local Testing

The keeper only depends on a small Soroban RPC surface during tests and local development. This mock server provides a lightweight JSON-RPC endpoint so you can run keeper flows without a full Soroban node.

## Supported methods

- `getHealth`
- `getNetwork`
- `getLatestLedger`
- `getEvents`
- `getAccount`
- `simulateTransaction`

## Start the mock server

From the `keeper/` directory:

```bash
npm run mock-rpc
```

By default the server listens on `http://127.0.0.1:4100`.

Optional environment variables:

```bash
MOCK_SOROBAN_RPC_HOST=127.0.0.1
MOCK_SOROBAN_RPC_PORT=4100
MOCK_SOROBAN_LEDGER_SEQUENCE=12345
NETWORK_PASSPHRASE="Test SDF Future Network ; October 2022"
```

## Point the keeper at the mock RPC

Set the keeper environment to the mock endpoint before starting tests or a local run:

```bash
export SOROBAN_RPC_URL=http://127.0.0.1:4100
export NETWORK_PASSPHRASE="Test SDF Future Network ; October 2022"
```

The production `createRpc` path already allows `http://` URLs, so no keeper code changes are required to swap between the real RPC and the mock server.

## Example JSON-RPC calls

```bash
curl -s http://127.0.0.1:4100 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'
```

```bash
curl -s http://127.0.0.1:4100 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"getHealth"}'
```

## Use it in tests

For unit and integration tests, instantiate the server directly so each test controls its own RPC state:

```js
const { MockSorobanRpcServer } = require('../src/mockRpcServer');

let mockRpc;

beforeAll(async () => {
  mockRpc = new MockSorobanRpcServer({ port: 0 });
  mockRpc.setLatestLedger({ sequence: 1000 });
  mockRpc.setAccount('GTESTACCOUNT', { sequence: '1' });
  await mockRpc.start();
});

afterAll(async () => {
  await mockRpc.stop();
});
```

You can tailor responses per test:

```js
mockRpc.setEvents([{ id: 'evt-1', ledger: 900, topic: ['task'] }]);
mockRpc.queueSimulationResponse({
  results: [{ retval: { mocked: true } }],
});
```

This keeps tests fast, deterministic, and independent from public RPC availability or rate limits.
