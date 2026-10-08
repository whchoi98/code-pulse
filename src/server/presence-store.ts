import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { PresenceSnapshot } from '../shared/types.js';

export type PresenceTotal = Pick<PresenceSnapshot, 'total_visitors' | 'counting_since'>;
export interface PresenceOperation { signal?: AbortSignal }
export interface PresenceStore {
  remember(hash: string, now: number, options?: PresenceOperation): Promise<boolean>;
  touch(hash: string, now: number, windowMs: number, options?: PresenceOperation): Promise<void>;
  countActive(cutoff: number, now: number, options?: PresenceOperation): Promise<number>;
  readTotal(options?: PresenceOperation): Promise<PresenceTotal | null>;
  close?(): void;
}
export type PresenceDynamo = (
  command: GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand,
  signal?: AbortSignal,
) => Promise<{ Item?: Record<string, unknown>; Attributes?: Record<string, unknown>; Count?: number; LastEvaluatedKey?: Record<string, unknown> }>;
export interface DynamoPresenceOptions {
  table: string;
  region?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxQueryPages?: number;
  queryPageSize?: number;
}

export const validPresenceCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const presenceUnavailable = () => new Error('Presence storage is unavailable.');

export function validatePresenceTotal(value: unknown): PresenceTotal {
  if (!value || typeof value !== 'object') throw presenceUnavailable();
  const record = value as Record<string, unknown>;
  const since = record.counting_since ?? null;
  if (!validPresenceCount(record.total_visitors) || (since !== null && (
    typeof since !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(since)
    || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 19) !== since.slice(0, 19)
  ))) throw presenceUnavailable();
  return { total_visitors: record.total_visitors, counting_since: since };
}

/** Development store: activity may expire, but the lifetime marker never does. */
export class MemoryPresenceStore implements PresenceStore {
  private readonly seen = new Set<string>();
  private readonly online = new Map<string, { last_seen: number; expires_at: number }>();
  private total: PresenceTotal | null = null;

  async remember(hash: string, now: number, { signal }: PresenceOperation = {}): Promise<boolean> {
    signal?.throwIfAborted();
    if (this.seen.has(hash)) return false;
    if (this.total?.total_visitors === Number.MAX_SAFE_INTEGER) throw presenceUnavailable();
    // No await separates the permanent marker and the increment.
    const countingSince = this.total?.counting_since ?? new Date(now).toISOString();
    this.seen.add(hash);
    this.total = { total_visitors: (this.total?.total_visitors ?? 0) + 1, counting_since: countingSince };
    return true;
  }

  async touch(hash: string, now: number, windowMs: number, { signal }: PresenceOperation = {}): Promise<void> {
    signal?.throwIfAborted();
    const previous = this.online.get(hash);
    if (previous && previous.last_seen >= now) return;
    this.online.set(hash, { last_seen: now, expires_at: Math.ceil((now + windowMs) / 1000) });
  }

  async countActive(cutoff: number, now: number, { signal }: PresenceOperation = {}): Promise<number> {
    signal?.throwIfAborted();
    let count = 0;
    for (const row of this.online.values()) {
      if (row.last_seen > cutoff && row.expires_at > Math.floor(now / 1000)) count++;
    }
    return count;
  }

  async readTotal({ signal }: PresenceOperation = {}): Promise<PresenceTotal | null> {
    signal?.throwIfAborted();
    return this.total && { ...this.total };
  }
}

const key = (partition: 'SEEN' | 'ONLINE' | 'META', id: string) => ({ pk: `PRESENCE#${partition}`, sk: id });
const errorName = (error: unknown) => error instanceof Error ? error.name : String((error as { name?: unknown })?.name);
const retryable = (error: unknown) => [
  'TransactionCanceledException', 'TransactionConflictException', 'TransactionInProgressException',
  'InternalServerError', 'ServiceUnavailable', 'ProvisionedThroughputExceededException',
  'RequestLimitExceeded', 'ThrottlingException', 'TimeoutError', 'NetworkingError',
].includes(errorName(error));

export class DynamoPresenceStore implements PresenceStore {
  private readonly dynamo: PresenceDynamo;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxQueryPages: number;
  private readonly queryPageSize: number;
  private client?: DynamoDBDocumentClient;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: DynamoPresenceOptions, { dynamo }: { dynamo?: PresenceDynamo } = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 25;
    this.maxQueryPages = options.maxQueryPages ?? 20;
    this.queryPageSize = options.queryPageSize ?? 1000;
    if (!options.table.trim() || !Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 5
      || !Number.isInteger(this.retryDelayMs) || this.retryDelayMs < 0 || this.retryDelayMs > 1000
      || !Number.isInteger(this.maxQueryPages) || this.maxQueryPages < 1 || this.maxQueryPages > 100
      || !Number.isInteger(this.queryPageSize) || this.queryPageSize < 1 || this.queryPageSize > 1000) {
      throw new Error('Invalid presence storage configuration.');
    }
    this.dynamo = dynamo ?? (async (command, signal) => {
      this.client ??= DynamoDBDocumentClient.from(new DynamoDBClient({
        region: options.region ?? process.env.AWS_REGION ?? 'ap-northeast-2', maxAttempts: 1,
      }));
      return await this.client.send(command as GetCommand, { abortSignal: signal });
    });
  }

  private async send(command: Parameters<PresenceDynamo>[0], signal?: AbortSignal) {
    const combined = AbortSignal.any([this.lifetime.signal, signal ?? AbortSignal.timeout(4000)]);
    combined.throwIfAborted();
    const result = await this.dynamo(command, combined);
    combined.throwIfAborted();
    return result;
  }

  private async seen(hash: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.send(new GetCommand({
      TableName: this.options.table, Key: key('SEEN', hash), ConsistentRead: true,
      ProjectionExpression: '#pk', ExpressionAttributeNames: { '#pk': 'pk' },
    }), signal);
    return Boolean(result.Item);
  }

  async readTotal({ signal }: PresenceOperation = {}): Promise<PresenceTotal | null> {
    const result = await this.send(new GetCommand({
      TableName: this.options.table, Key: key('META', 'TOTAL'), ConsistentRead: true,
      ProjectionExpression: '#total, #since',
      ExpressionAttributeNames: { '#total': 'total_visitors', '#since': 'counting_since' },
    }), signal);
    return result.Item ? validatePresenceTotal(result.Item) : null;
  }

  async remember(hash: string, now: number, { signal }: PresenceOperation = {}): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      signal?.throwIfAborted();
      if (await this.seen(hash, signal)) return false;
      const total = await this.readTotal({ signal });
      if (total?.total_visitors === Number.MAX_SAFE_INTEGER) throw presenceUnavailable();
      const update: Required<Pick<UpdateCommand['input'],
        'UpdateExpression' | 'ConditionExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'
      >> = total === null ? {
        UpdateExpression: 'SET #total = :one, #since = :since',
        ConditionExpression: 'attribute_not_exists(#pk)',
        ExpressionAttributeNames: { '#pk': 'pk', '#total': 'total_visitors', '#since': 'counting_since' },
        ExpressionAttributeValues: { ':one': 1, ':since': new Date(now).toISOString() },
      } : {
        UpdateExpression: 'ADD #total :one',
        ConditionExpression: '#total >= :zero AND #total < :max',
        ExpressionAttributeNames: { '#total': 'total_visitors' },
        ExpressionAttributeValues: { ':one': 1, ':zero': 0, ':max': Number.MAX_SAFE_INTEGER },
      };
      try {
        await this.send(new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            { Put: {
              TableName: this.options.table, Item: { ...key('SEEN', hash), first_seen: now },
              ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' },
            } },
            { Update: { TableName: this.options.table, Key: key('META', 'TOTAL'), ...update } },
          ],
        }), signal);
        return true;
      } catch (error) {
        signal?.throwIfAborted();
        // The transaction may have committed even when its response was lost.
        if (await this.seen(hash, signal)) return false;
        if (!retryable(error) || attempt + 1 === this.maxAttempts) throw error;
        if (this.retryDelayMs) await delay(this.retryDelayMs * 2 ** attempt, undefined, { signal });
      }
    }
    throw presenceUnavailable();
  }

  async touch(hash: string, now: number, windowMs: number, { signal }: PresenceOperation = {}): Promise<void> {
    try {
      await this.send(new UpdateCommand({
        TableName: this.options.table, Key: key('ONLINE', hash),
        UpdateExpression: 'SET #last = :now, #expires = :expires',
        ConditionExpression: 'attribute_not_exists(#last) OR #last < :now',
        ExpressionAttributeNames: { '#last': 'last_seen', '#expires': 'expires_at' },
        ExpressionAttributeValues: { ':now': now, ':expires': Math.ceil((now + windowMs) / 1000) },
      }), signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (errorName(error) !== 'ConditionalCheckFailedException') throw error;
    }
  }

  async countActive(cutoff: number, now: number, { signal }: PresenceOperation = {}): Promise<number> {
    let cursor: Record<string, unknown> | undefined;
    let count = 0;
    for (let page = 0; page < this.maxQueryPages; page++) {
      const result = await this.send(new QueryCommand({
        TableName: this.options.table, ConsistentRead: true, Select: 'COUNT', Limit: this.queryPageSize,
        KeyConditionExpression: '#pk = :online',
        FilterExpression: '#last > :cutoff AND #expires > :now',
        ExpressionAttributeNames: { '#pk': 'pk', '#last': 'last_seen', '#expires': 'expires_at' },
        ExpressionAttributeValues: { ':online': 'PRESENCE#ONLINE', ':cutoff': cutoff, ':now': Math.floor(now / 1000) },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }), signal);
      if (!validPresenceCount(result.Count) || !validPresenceCount(count + result.Count)) throw presenceUnavailable();
      count += result.Count;
      cursor = result.LastEvaluatedKey;
      if (!cursor || !Object.keys(cursor).length) return count;
    }
    throw presenceUnavailable();
  }

  close(): void {
    this.lifetime.abort(presenceUnavailable());
    this.client?.destroy();
  }
}
