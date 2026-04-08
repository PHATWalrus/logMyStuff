import { extname, join } from "node:path";
import { createLogStore } from "./storage";
import { LOG_LEVELS, type JsonObject, type LogEntry, type LogLevel } from "./types";

const port = Number(Bun.env.PORT ?? "3000");
const publicDir = join(import.meta.dir, "..", "public");
const store = await createLogStore();
const logTopic = "logs";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": Bun.env.CORS_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers
  });
}

function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(body, { ...init, headers });
}

function sanitizeObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function normalizeLevel(value: unknown): LogLevel {
  const normalized = String(value ?? "info").toLowerCase();
  if (LOG_LEVELS.includes(normalized as LogLevel)) {
    return normalized as LogLevel;
  }
  return "info";
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 20);
}

function coerceTimestamp(value: unknown): string {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function buildLogEntry(payload: Record<string, unknown>): LogEntry {
  const message = String(payload.message ?? payload.text ?? "").trim();
  if (!message) {
    throw new Error("`message` is required.");
  }

  return {
    id: crypto.randomUUID(),
    timestamp: coerceTimestamp(payload.timestamp),
    level: normalizeLevel(payload.level),
    message,
    source: String(payload.source ?? payload.service ?? payload.app ?? "unknown").trim() || "unknown",
    hostname: payload.hostname ? String(payload.hostname) : undefined,
    tags: normalizeTags(payload.tags),
    metadata: sanitizeObject(payload.metadata)
  };
}

function parseTagsHeader(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function parsePlaintextLogs(request: Request, raw: string): LogEntry[] {
  const source = request.headers.get("x-log-source")?.trim() || "plaintext";
  const hostname = request.headers.get("x-log-hostname")?.trim() || undefined;
  const tags = parseTagsHeader(request.headers.get("x-log-tags"));
  const defaultLevel = normalizeLevel(request.headers.get("x-log-level") ?? "info");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new Error("Plaintext body was empty.");
  }

  return lines.map((line) => {
    const match =
      line.match(/^\[(?<timestamp>[^\]]+)\]\s+\[(?<level>trace|debug|info|warn|error|fatal)\]\s+(?<message>.+)$/i) ??
      line.match(
        /^(?<timestamp>\d{4}-\d{2}-\d{2}T[^\s]+)\s+(?<level>trace|debug|info|warn|error|fatal)\s+(?<message>.+)$/i
      ) ??
      line.match(/^(?<level>trace|debug|info|warn|error|fatal)\s*[:-]?\s*(?<message>.+)$/i) ??
      line.match(/^\[(?<timestamp>[^\]]+)\]\s+(?<message>.+)$/i);

    return buildLogEntry({
      timestamp: match?.groups?.timestamp,
      level: match?.groups?.level ?? defaultLevel,
      message: match?.groups?.message ?? line,
      source,
      hostname,
      tags,
      metadata: {
        format: "plaintext"
      }
    });
  });
}

function parseQuery(url: URL) {
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? "250")));
  const level = url.searchParams.get("level")?.trim() || undefined;
  const source = url.searchParams.get("source")?.trim() || undefined;
  const search = url.searchParams.get("search")?.trim() || undefined;
  return { limit, level, source, search };
}

function parseSocketQuery(payload: Record<string, unknown>) {
  const rawLimit = Number(payload.limit ?? 250);
  return {
    limit: Math.max(1, Math.min(1000, Number.isFinite(rawLimit) ? rawLimit : 250)),
    level: typeof payload.level === "string" && payload.level.trim() ? payload.level.trim() : undefined,
    source: typeof payload.source === "string" && payload.source.trim() ? payload.source.trim() : undefined,
    search: typeof payload.search === "string" && payload.search.trim() ? payload.search.trim() : undefined
  };
}

function toCsv(logs: LogEntry[]): string {
  const header = ["timestamp", "level", "source", "message", "hostname", "tags", "metadata"];
  const rows = logs.map((log) =>
    [
      log.timestamp,
      log.level,
      log.source,
      log.message,
      log.hostname ?? "",
      log.tags.join("|"),
      JSON.stringify(log.metadata)
    ]
      .map((value) => `"${String(value).replaceAll('"', '""')}"`)
      .join(",")
  );
  return [header.join(","), ...rows].join("\n");
}

async function serveStatic(pathname: string): Promise<Response> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = join(publicDir, relativePath);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  headers.set("Content-Type", mimeTypes[extname(filePath)] ?? "application/octet-stream");
  return new Response(file, { headers });
}

async function buildSnapshot(payload: Record<string, unknown> = {}) {
  const query = parseSocketQuery(payload);
  const logs = await store.list(query);
  return {
    type: "snapshot",
    requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
    query,
    totalLogs: await store.count(),
    visibleLogs: logs.length,
    store: await store.info(),
    logs
  };
}

const server = Bun.serve({
  port,
  idleTimeout: 30,
  routes: {
    "/health": async () =>
      json({
        ok: true,
        port,
        store: await store.info(),
        totalLogs: await store.count(),
        now: new Date().toISOString()
      })
  },
  websocket: {
    data: {} as { connectedAt: string },
    async open(ws) {
      ws.subscribe(logTopic);
      ws.send(
        JSON.stringify({
          type: "connected",
          connectedAt: ws.data.connectedAt,
          totalLogs: await store.count(),
          store: await store.info()
        })
      );
    },
    async message(ws, rawMessage) {
      try {
        const message = JSON.parse(String(rawMessage)) as Record<string, unknown>;
        const type = typeof message.type === "string" ? message.type : "";

        if (type === "get_logs") {
          ws.send(JSON.stringify(await buildSnapshot(message)));
          return;
        }

        if (type === "clear_logs") {
          const cleared = await store.clear();
          const totalLogs = await store.count();
          ws.send(
            JSON.stringify({
              type: "cleared",
              requestId: typeof message.requestId === "string" ? message.requestId : undefined,
              cleared,
              totalLogs
            })
          );
          server.publish(
            logTopic,
            JSON.stringify({
              type: "invalidate",
              reason: "cleared",
              totalLogs
            })
          );
          return;
        }

        if (type === "export_logs") {
          const query = parseSocketQuery(message);
          const logs = await store.list({
            ...query,
            limit: 5000
          });
          const format = message.format === "csv" ? "csv" : "json";
          const content = format === "csv" ? toCsv(logs) : JSON.stringify(logs, null, 2);
          ws.send(
            JSON.stringify({
              type: "exported",
              requestId: typeof message.requestId === "string" ? message.requestId : undefined,
              format,
              filename: `logs-${Date.now()}.${format}`,
              mimeType: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8",
              content
            })
          );
          return;
        }

        ws.send(
          JSON.stringify({
            type: "error",
            requestId: typeof message.requestId === "string" ? message.requestId : undefined,
            error: "Unknown socket action."
          })
        );
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: error instanceof Error ? error.message : "Invalid socket payload."
          })
        );
      }
    }
  },
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (request.method === "GET" && url.pathname === "/ws") {
      const upgraded = server.upgrade(request, {
        data: {
          connectedAt: new Date().toISOString()
        }
      });

      if (upgraded) {
        return;
      }

      return json(
        {
          ok: false,
          error: "WebSocket upgrade failed."
        },
        { status: 400 }
      );
    }

    if (request.method === "POST" && url.pathname === "/api/logs") {
      try {
        const contentType = request.headers.get("content-type") ?? "";

        if (!contentType || contentType.includes("text/plain")) {
          const raw = await request.text();
          const logs = parsePlaintextLogs(request, raw);
          await store.addMany(logs);
          const totalLogs = await store.count();
          server.publish(
            logTopic,
            JSON.stringify({
              type: "invalidate",
              reason: "ingested",
              inserted: logs.length,
              totalLogs
            })
          );
          return json({ ok: true, inserted: logs.length, totalLogs, logs }, { status: 201 });
        }

        const body = (await request.json()) as unknown;
        const incoming = Array.isArray(body)
          ? body
          : Array.isArray((body as { logs?: unknown[] })?.logs)
            ? (body as { logs: unknown[] }).logs
            : [body];

        const logs = incoming.map((entry) => buildLogEntry((entry ?? {}) as Record<string, unknown>));
        await store.addMany(logs);
        const totalLogs = await store.count();
        server.publish(
          logTopic,
          JSON.stringify({
            type: "invalidate",
            reason: "ingested",
            inserted: logs.length,
            totalLogs
          })
        );

        return json(
          {
            ok: true,
            inserted: logs.length,
            totalLogs,
            logs
          },
          { status: 201 }
        );
      } catch (error) {
        return json(
          {
            ok: false,
            error: error instanceof Error ? error.message : "Unable to store logs."
          },
          { status: 400 }
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/api/logs") {
      const query = parseQuery(url);
      const logs = await store.list(query);
      return json({
        ok: true,
        query,
        totalLogs: await store.count(),
        visibleLogs: logs.length,
        store: await store.info(),
        logs
      });
    }

    if (request.method === "DELETE" && url.pathname === "/api/logs") {
      const cleared = await store.clear();
      server.publish(
        logTopic,
        JSON.stringify({
          type: "invalidate",
          reason: "cleared",
          cleared,
          totalLogs: await store.count()
        })
      );
      return json({
        ok: true,
        cleared
      });
    }

    if (request.method === "GET" && url.pathname === "/api/logs/export") {
      const query = parseQuery(url);
      const logs = await store.list({
        ...query,
        limit: 5000
      });
      const format = (url.searchParams.get("format") ?? "json").toLowerCase();

      if (format === "csv") {
        return text(toCsv(logs), {
          headers: {
            "Content-Disposition": `attachment; filename="logs-${Date.now()}.csv"`
          }
        });
      }

      return json(logs, {
        headers: {
          "Content-Disposition": `attachment; filename="logs-${Date.now()}.json"`
        }
      });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
      return serveStatic(url.pathname === "/" ? "/index.html" : url.pathname.replace(/^\/assets/, ""));
    }

    if (request.method === "GET" && ["/index.html", "/app.js", "/styles.css"].includes(url.pathname)) {
      return serveStatic(url.pathname);
    }

    return json(
      {
        ok: false,
        error: "Route not found."
      },
      { status: 404 }
    );
  }
});

console.log(`LogMyStuff listening on http://localhost:${server.port}`);
