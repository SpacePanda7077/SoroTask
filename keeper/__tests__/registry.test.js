const fs = require('fs');
const path = require('path');
const { xdr } = require('@stellar/stellar-sdk');

// Mock fs so we don't touch the real filesystem
jest.mock('fs');

const TaskRegistry = require('../src/registry');

function makeTaskRegisteredEvent(taskId, ledger) {
    // topic[0] = Symbol("TaskRegistered"), topic[1] = u64 task_id
    const topic0 = xdr.ScVal.scvSymbol('TaskRegistered').toXDR('base64');
    const topic1 = xdr.ScVal.scvU64(xdr.Uint64.fromString(String(taskId))).toXDR('base64');
    return {
        topic: [topic0, topic1],
        ledger,
    };
}

function mockServer(events = []) {
    return {
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1000 }),
        getEvents: jest.fn().mockResolvedValue({ events }),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync.mockReturnValue(false);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
});

describe('TaskRegistry', () => {
    test('discovers task IDs from events on init', async () => {
        const events = [
            makeTaskRegisteredEvent(1, 900),
            makeTaskRegisteredEvent(2, 910),
            makeTaskRegisteredEvent(3, 920),
        ];
        const server = mockServer(events);
        const registry = new TaskRegistry(server, 'CABC123', { startLedger: 800 });

        await registry.init();

        expect(registry.getTaskIds()).toEqual([1, 2, 3]);
        expect(server.getEvents).toHaveBeenCalledTimes(1);
    });

    test('returns empty array when no events exist', async () => {
        const server = mockServer([]);
        const registry = new TaskRegistry(server, 'CABC123', { startLedger: 800 });

        await registry.init();

        expect(registry.getTaskIds()).toEqual([]);
    });

    test('deduplicates task IDs', async () => {
        const events = [
            makeTaskRegisteredEvent(1, 900),
            makeTaskRegisteredEvent(1, 910),
        ];
        const server = mockServer(events);
        const registry = new TaskRegistry(server, 'CABC123', { startLedger: 800 });

        await registry.init();

        expect(registry.getTaskIds()).toEqual([1]);
    });

    test('poll discovers new tasks', async () => {
        const server = mockServer([makeTaskRegisteredEvent(1, 900)]);
        const registry = new TaskRegistry(server, 'CABC123', { startLedger: 800 });
        await registry.init();

        // Simulate new events on next poll
        server.getEvents.mockResolvedValueOnce({
            events: [makeTaskRegisteredEvent(4, 950)],
        });

        await registry.poll();

        expect(registry.getTaskIds()).toEqual([1, 4]);
    });

    test('persists task IDs to disk', async () => {
        const server = mockServer([makeTaskRegisteredEvent(5, 900)]);
        const registry = new TaskRegistry(server, 'CABC123', { startLedger: 800 });

        await registry.init();

        expect(fs.writeFileSync).toHaveBeenCalled();
        const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(writtenData.taskIds).toEqual([5]);
        expect(writtenData.lastSeenLedger).toBe(900);
    });

    test('loads persisted state from disk', async () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify({
            taskIds: [10, 20],
            lastSeenLedger: 500,
        }));

        const server = mockServer([]);
        const registry = new TaskRegistry(server, 'CABC123');

        expect(registry.getTaskIds()).toEqual([10, 20]);
    });

    test('handles RPC errors gracefully', async () => {
        const server = {
            getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1000 }),
            getEvents: jest.fn().mockRejectedValue(new Error('RPC unavailable')),
        };
        const registry = new TaskRegistry(server, 'CABC123', { startLedger: 800 });

        // Should not throw
        await registry.init();

        expect(registry.getTaskIds()).toEqual([]);
    });

    test('auto-detects start ledger when none provided', async () => {
        const server = mockServer([]);
        const registry = new TaskRegistry(server, 'CABC123');

        await registry.init();

        expect(server.getLatestLedger).toHaveBeenCalled();
    });
});
