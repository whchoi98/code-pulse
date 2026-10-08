import { describe, expect, it } from 'vitest';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  DynamoPresenceStore, MemoryPresenceStore, type PresenceDynamo, type PresenceTotal,
} from '../src/server/presence-store.js';

const time = Date.parse('2026-10-07T19:00:00Z');
const windowMs = 90_000;
const namedError = (name: string) => Object.assign(new Error(name), { name });

describe('presence memory storage', () => {
  it('counts a browser once across concurrent first visits and preserves the first counting date', async () => {
    const store = new MemoryPresenceStore();
    expect(await store.readTotal()).toBeNull();
    await Promise.all(Array.from({ length: 12 }, () => store.remember('browser-a', time)));
    await store.remember('browser-b', time + 1000);
    await store.remember('browser-a', time + 2000);

    expect(await store.readTotal()).toEqual({ total_visitors: 2, counting_since: '2026-10-07T19:00:00.000Z' });
  });

  it('expires activity at 90 seconds without expiring the permanent visitor marker', async () => {
    const store = new MemoryPresenceStore();
    await store.remember('browser-a', time);
    await store.touch('browser-a', time, windowMs);
    expect(await store.countActive(time + 89_999 - windowMs, time + 89_999)).toBe(1);
    expect(await store.countActive(time, time + windowMs)).toBe(0);
    expect(await store.remember('browser-a', time + windowMs + 1)).toBe(false);
    await store.touch('browser-a', time + windowMs + 1, windowMs);
    expect(await store.countActive(time + 1, time + windowMs + 1)).toBe(1);
    expect((await store.readTotal())?.total_visitors).toBe(1);
  });

  it('does not let a delayed heartbeat shorten a newer activity window', async () => {
    const store = new MemoryPresenceStore();
    await store.remember('browser-a', time);
    await store.touch('browser-a', time + 60_000, windowMs);
    await store.touch('browser-a', time, windowMs);

    expect(await store.countActive(time + 59_999, time + 149_999)).toBe(1);
    expect(await store.countActive(time + 60_000, time + 150_000)).toBe(0);
  });
});

/** Models the two atomic actions, including a response lost after commit. */
class TransactionBoundary {
  seen = new Set<string>();
  total: PresenceTotal | null = null;
  transactions: TransactWriteCommand[] = [];
  loseResponse = false;
  dynamo: PresenceDynamo = async command => {
    if (command instanceof GetCommand) {
      return command.input.Key?.pk === 'PRESENCE#SEEN'
        ? this.seen.has(String(command.input.Key?.sk)) ? { Item: { pk: 'PRESENCE#SEEN' } } : {}
        : this.total ? { Item: { ...this.total } } : {};
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error('Unexpected DynamoDB operation');
    this.transactions.push(command);
    const actions = command.input.TransactItems!;
    expect(actions).toHaveLength(2);
    const marker = actions.find(action => action.Put)?.Put!;
    const counter = actions.find(action => action.Update)?.Update!;
    expect(marker.ConditionExpression).toMatch(/attribute_not_exists/);
    expect(marker.Item).not.toHaveProperty('expires_at');
    expect(counter.Key).toEqual({ pk: 'PRESENCE#META', sk: 'TOTAL' });
    await Promise.resolve();
    const hash = String(marker.Item?.sk);
    if (this.seen.has(hash)) throw namedError('TransactionCanceledException');
    const values = counter.ExpressionAttributeValues!;
    if (counter.ConditionExpression?.includes('attribute_not_exists')) {
      if (this.total) throw namedError('TransactionCanceledException');
      this.total = { total_visitors: Number(values[':one']), counting_since: String(values[':since']) };
    } else {
      if (!this.total) throw namedError('TransactionCanceledException');
      this.total = { ...this.total, total_visitors: this.total.total_visitors + Number(values[':one']) };
    }
    this.seen.add(hash);
    if (this.loseResponse) { this.loseResponse = false; throw namedError('TimeoutError'); }
    return {};
  };
}

describe('presence DynamoDB storage', () => {
  it('uses permanent markers and one atomic counter update across independent store instances', async () => {
    const boundary = new TransactionBoundary();
    const first = new DynamoPresenceStore({ table: 'presence-test', retryDelayMs: 0 }, { dynamo: boundary.dynamo });
    const second = new DynamoPresenceStore({ table: 'presence-test', retryDelayMs: 0 }, { dynamo: boundary.dynamo });
    await Promise.all([first.remember('same-browser', time), second.remember('same-browser', time)]);
    await Promise.all([first.remember('another-browser', time + 1000), second.remember('third-browser', time + 1000)]);
    const restarted = new DynamoPresenceStore({ table: 'presence-test' }, { dynamo: boundary.dynamo });
    await restarted.remember('same-browser', time + 2000);

    expect(await restarted.readTotal()).toEqual({ total_visitors: 3, counting_since: '2026-10-07T19:00:00.000Z' });
    expect(boundary.seen.size).toBe(3);
    expect(boundary.transactions.length).toBeGreaterThanOrEqual(3);
  });

  it('resolves an ambiguous committed transaction through its marker without incrementing twice', async () => {
    const boundary = new TransactionBoundary();
    boundary.loseResponse = true;
    const store = new DynamoPresenceStore({ table: 'presence-test', retryDelayMs: 0 }, { dynamo: boundary.dynamo });
    await store.remember('browser-a', time);
    await store.remember('browser-a', time + 1000);

    expect(await store.readTotal()).toEqual({ total_visitors: 1, counting_since: '2026-10-07T19:00:00.000Z' });
    expect(boundary.transactions).toHaveLength(1);
  });

  it('bounds failed transaction retries and does not create a marker for an uncommitted visit', async () => {
    let transactions = 0;
    const store = new DynamoPresenceStore({ table: 'presence-test', maxAttempts: 2, retryDelayMs: 0 }, {
      dynamo: async command => {
        if (command instanceof GetCommand) return {};
        transactions++;
        throw namedError('ProvisionedThroughputExceededException');
      },
    });
    await expect(store.remember('browser-a', time)).rejects.toThrow();
    expect(transactions).toBe(2);
  });

  it('sets the exact TTL attribute and prevents older writes from replacing newer heartbeat times', async () => {
    const writes: UpdateCommand[] = [];
    const store = new DynamoPresenceStore({ table: 'presence-test' }, {
      dynamo: async command => {
        expect(command).toBeInstanceOf(UpdateCommand);
        writes.push(command as UpdateCommand);
        const input = (command as UpdateCommand).input;
        expect(input.Key).toEqual({ pk: 'PRESENCE#ONLINE', sk: 'browser-a' });
        expect(input.ExpressionAttributeNames?.['#expires']).toBe('expires_at');
        expect(input.ExpressionAttributeValues?.[':now']).toBe(time);
        expect(input.ExpressionAttributeValues?.[':expires']).toBe(Math.ceil((time + windowMs) / 1000));
        expect(input.ConditionExpression).toMatch(/#last < :now/);
        throw namedError('ConditionalCheckFailedException');
      },
    });
    await expect(store.touch('browser-a', time, windowMs)).resolves.toBeUndefined();
    expect(writes).toHaveLength(1);
  });

  it('counts all query pages with a timestamp filter even while expired TTL rows still exist', async () => {
    const cursor = { pk: 'PRESENCE#ONLINE', sk: 'page-one-last' };
    let pages = 0;
    const store = new DynamoPresenceStore({ table: 'presence-test' }, {
      dynamo: async command => {
        expect(command).toBeInstanceOf(QueryCommand);
        const input = (command as QueryCommand).input;
        expect(input.ConsistentRead).toBe(true);
        expect(input.Select).toBe('COUNT');
        expect(input.FilterExpression).toMatch(/#last > :cutoff/);
        expect(input.FilterExpression).toMatch(/#expires > :now/);
        expect(input.ExpressionAttributeNames?.['#expires']).toBe('expires_at');
        expect(input.ExpressionAttributeValues?.[':cutoff']).toBe(time - windowMs);
        expect(input.ExpressionAttributeValues?.[':now']).toBe(time / 1000);
        if (++pages === 1) return { Count: 0, LastEvaluatedKey: cursor };
        expect(input.ExclusiveStartKey).toEqual(cursor);
        return { Count: 3 };
      },
    });
    expect(await store.countActive(time - windowMs, time)).toBe(3);
    expect(pages).toBe(2);
  });

  it.each(['failure', 'page limit', 'malformed count'] as const)('never returns a partial or invented count after %s', async problem => {
    let pages = 0;
    const store = new DynamoPresenceStore({ table: 'presence-test', maxQueryPages: 2 }, {
      dynamo: async () => {
        if (++pages === 1) return { Count: 2, LastEvaluatedKey: { pk: 'PRESENCE#ONLINE', sk: 'cursor' } };
        if (problem === 'failure') throw new Error('database unavailable');
        if (problem === 'malformed count') return {};
        return { Count: 1, LastEvaluatedKey: { pk: 'PRESENCE#ONLINE', sk: 'still-more' } };
      },
    });
    await expect(store.countActive(time - windowMs, time)).rejects.toThrow();
  });

  it('distinguishes a truly empty total from corrupt or unavailable storage', async () => {
    const empty = new DynamoPresenceStore({ table: 'presence-test' }, { dynamo: async () => ({}) });
    expect(await empty.readTotal()).toBeNull();
    const corrupt = new DynamoPresenceStore({ table: 'presence-test' }, { dynamo: async () => ({ Item: { total_visitors: 'unknown' } }) });
    await expect(corrupt.readTotal()).rejects.toThrow();
    const missingTable = new DynamoPresenceStore({ table: 'presence-test' }, { dynamo: async () => { throw namedError('ResourceNotFoundException'); } });
    await expect(missingTable.readTotal()).rejects.toThrow();
  });
});
