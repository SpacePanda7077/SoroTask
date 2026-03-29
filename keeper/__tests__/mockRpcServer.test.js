const http = require('http');
const {
  MockSorobanRpcServer,
  DEFAULT_NETWORK_PASSPHRASE,
} = require('../src/mockRpcServer');

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
      },
      (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          resolve(JSON.parse(data));
        });
      },
    );

    request.on('error', reject);
    request.write(JSON.stringify(payload));
    request.end();
  });
}

describe('MockSorobanRpcServer', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('serves health, network, and latest ledger responses', async () => {
    server = new MockSorobanRpcServer({
      port: 0,
      latestLedger: { sequence: 321 },
    });

    const url = await server.start();
    const [health, network, latestLedger] = await Promise.all([
      postJson(url, { jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      postJson(url, { jsonrpc: '2.0', id: 2, method: 'getNetwork' }),
      postJson(url, { jsonrpc: '2.0', id: 3, method: 'getLatestLedger' }),
    ]);

    expect(health.result).toEqual({ status: 'healthy' });
    expect(network.result).toMatchObject({
      passphrase: DEFAULT_NETWORK_PASSPHRASE,
    });
    expect(latestLedger.result.sequence).toBe(321);
  });

  it('filters events and returns queued simulation responses', async () => {
    server = new MockSorobanRpcServer({
      port: 0,
      events: [
        { id: 'evt-1', ledger: 10, topic: ['a'] },
        { id: 'evt-2', ledger: 12, topic: ['b'] },
      ],
      defaultSimulationResponse: { results: [{ retval: 'default' }] },
    });
    server.queueSimulationResponse({ results: [{ retval: 'queued' }] });

    const url = await server.start();
    const events = await postJson(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getEvents',
      params: [{ startLedger: 11 }],
    });
    const firstSimulation = await postJson(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'simulateTransaction',
    });
    const secondSimulation = await postJson(url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'simulateTransaction',
    });

    expect(events.result.events).toHaveLength(1);
    expect(events.result.events[0].id).toBe('evt-2');
    expect(firstSimulation.result.results[0].retval).toBe('queued');
    expect(secondSimulation.result.results[0].retval).toBe('default');
  });

  it('returns configured accounts and JSON-RPC errors for unknown methods', async () => {
    server = new MockSorobanRpcServer({ port: 0 });
    server.setAccount('GTESTACCOUNT', {
      sequence: '99',
      balances: [{ asset_type: 'native', balance: '42.0000000' }],
    });

    const url = await server.start();
    const account = await postJson(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccount',
      params: [{ accountId: 'GTESTACCOUNT' }],
    });
    const missingMethod = await postJson(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'notReal',
    });

    expect(account.result).toMatchObject({
      accountId: 'GTESTACCOUNT',
      sequence: '99',
    });
    expect(missingMethod.error).toMatchObject({
      code: -32601,
    });
  });
});
