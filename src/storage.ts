import Redis from "ioredis";
import type { LogEntry, LogQuery, LogStore, LogStoreInfo } from "./types";

const DEFAULT_KEY = "logmystuff:logs";

function parseMaxEntries(): number {
  const raw = Number(Bun.env.MAX_LOG_ENTRIES ?? "5000");
  if (!Number.isFinite(raw) || raw < 100) {
    return 5000;
  }
  return Math.floor(raw);
}

function normalizeSource(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeSearch(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function matchesQuery(log: LogEntry, query: LogQuery): boolean {
  if (query.level && log.level !== query.level) {
    return false;
  }

  if (query.source && normalizeSource(log.source) !== normalizeSource(query.source)) {
    return false;
  }

  if (!query.search) {
    return true;
  }

  const needle = normalizeSearch(query.search);
  if (!needle) {
    return true;
  }

  const haystack = [
    log.message,
    log.source,
    log.hostname ?? "",
    JSON.stringify(log.metadata),
    log.tags.join(" ")
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(needle);
}

function sliceNewest(logs: LogEntry[], limit: number): LogEntry[] {
  return [...logs].reverse().slice(0, limit);
}

class MemoryLogStore implements LogStore {
  private readonly logs: LogEntry[] = [];

  constructor(private readonly maxEntries: number) {}

  async add(log: LogEntry): Promise<void> {
    this.logs.push(log);
    if (this.logs.length > this.maxEntries) {
      this.logs.splice(0, this.logs.length - this.maxEntries);
    }
  }

  async addMany(logs: LogEntry[]): Promise<void> {
    for (const log of logs) {
      this.logs.push(log);
    }
    if (this.logs.length > this.maxEntries) {
      this.logs.splice(0, this.logs.length - this.maxEntries);
    }
  }

  async list(query: LogQuery): Promise<LogEntry[]> {
    const filtered = this.logs.filter((log) => matchesQuery(log, query));
    return sliceNewest(filtered, query.limit);
  }

  async count(): Promise<number> {
    return this.logs.length;
  }

  async clear(): Promise<number> {
    const cleared = this.logs.length;
    this.logs.length = 0;
    return cleared;
  }

  async info(): Promise<LogStoreInfo> {
    return {
      driver: "memory",
      maxEntries: this.maxEntries
    };
  }
}

class RedisLogStore implements LogStore {
  constructor(
    private readonly client: Redis,
    private readonly key: string,
    private readonly maxEntries: number
  ) {}

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async add(log: LogEntry): Promise<void> {
    await this.client.rpush(this.key, JSON.stringify(log));
    await this.client.ltrim(this.key, -this.maxEntries, -1);
  }

  async addMany(logs: LogEntry[]): Promise<void> {
    if (!logs.length) {
      return;
    }

    const pipeline = this.client.pipeline();
    pipeline.rpush(
      this.key,
      ...logs.map((log) => JSON.stringify(log))
    );
    pipeline.ltrim(this.key, -this.maxEntries, -1);
    await pipeline.exec();
  }

  async list(query: LogQuery): Promise<LogEntry[]> {
    const items = await this.client.lrange(this.key, 0, -1);
    const parsed = items.flatMap((item) => {
      try {
        return [JSON.parse(item) as LogEntry];
      } catch {
        return [];
      }
    });
    const filtered = parsed.filter((log) => matchesQuery(log, query));
    return sliceNewest(filtered, query.limit);
  }

  async count(): Promise<number> {
    return this.client.llen(this.key);
  }

  async clear(): Promise<number> {
    const total = Number(await this.client.llen(this.key));
    await this.client.del(this.key);
    return total;
  }

  async info(): Promise<LogStoreInfo> {
    return {
      driver: "redis",
      maxEntries: this.maxEntries
    };
  }
}

function buildRedisUrl(): string | undefined {
  if (Bun.env.REDIS_URL) {
    return Bun.env.REDIS_URL;
  }

  if (!Bun.env.REDIS_HOST) {
    return undefined;
  }

  const protocol = Bun.env.REDIS_TLS === "true" ? "rediss" : "redis";
  const auth = Bun.env.REDIS_PASSWORD
    ? `:${encodeURIComponent(Bun.env.REDIS_PASSWORD)}@`
    : "";
  const port = Bun.env.REDIS_PORT ?? "6379";
  const db = Bun.env.REDIS_DB ? `/${Bun.env.REDIS_DB}` : "";

  return `${protocol}://${auth}${Bun.env.REDIS_HOST}:${port}${db}`;
}

export async function createLogStore(): Promise<LogStore> {
  const maxEntries = parseMaxEntries();
  const requestedDriver = (Bun.env.STORAGE_DRIVER ?? "").toLowerCase();
  const redisUrl = buildRedisUrl();
  const useRedis = requestedDriver === "redis" || (!requestedDriver && Boolean(redisUrl));

  if (useRedis && redisUrl) {
    try {
      const client = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        enableReadyCheck: true
      });
      const store = new RedisLogStore(
        client,
        Bun.env.REDIS_KEY ?? DEFAULT_KEY,
        maxEntries
      );
      await store.ping();
      return store;
    } catch (error) {
      console.warn("Redis unavailable, falling back to in-memory storage.", error);
    }
  }

  return new MemoryLogStore(maxEntries);
}
