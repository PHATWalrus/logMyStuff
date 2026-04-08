export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal"
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
  hostname?: string;
  tags: string[];
  metadata: JsonObject;
}

export interface LogQuery {
  limit: number;
  level?: string;
  source?: string;
  search?: string;
}

export interface LogStoreInfo {
  driver: "memory" | "redis";
  maxEntries: number;
}

export interface LogStore {
  add(log: LogEntry): Promise<void>;
  addMany(logs: LogEntry[]): Promise<void>;
  list(query: LogQuery): Promise<LogEntry[]>;
  count(): Promise<number>;
  clear(): Promise<number>;
  info(): Promise<LogStoreInfo>;
}
