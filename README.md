# LogMyStuff

A Bun-based logging server with a built-in dashboard for viewing, filtering, clearing, and exporting logs.

## Features

- Single ingestion endpoint at `POST /api/logs`
- Built-in UI at `/`
- WebSocket live updates for the dashboard at `/ws`
- Dashboard actions use WebSockets for refresh, filter, clear, and export
- Toggle between card view and raw JSON line view in the UI
- Memory storage by default
- Redis storage with env-based switch
- Clear-all action from the UI or `DELETE /api/logs`
- JSON and CSV export
- Nixpacks config for Coolify deployment

## Quick start

```bash
bun install
bun run dev
```

Open `http://localhost:3000`.

## Environment

Copy `.env.example` to `.env` if you want to customize settings.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `STORAGE_DRIVER` | `memory` | `memory` or `redis` |
| `MAX_LOG_ENTRIES` | `5000` | Retention cap |
| `CORS_ORIGIN` | `*` | CORS origin for the ingestion API |
| `REDIS_URL` | - | Example: `redis://localhost:6379` |
| `REDIS_KEY` | `logmystuff:logs` | Redis list key |

## API

### Push logs

```bash
curl -X POST http://localhost:3000/api/logs \
  -H "Content-Type: application/json" \
  -d '{
    "level": "error",
    "source": "payments-api",
    "message": "Stripe request failed",
    "hostname": "worker-01",
    "tags": ["billing", "critical"],
    "metadata": {
      "orderId": "ord_123",
      "statusCode": 502
    }
  }'
```

Plaintext also works:

```bash
curl -X POST http://localhost:3000/api/logs \
  -H "Content-Type: text/plain" \
  -H "X-Log-Source: nginx" \
  -H "X-Log-Hostname: edge-1" \
  -H "X-Log-Tags: prod,plaintext" \
  --data-binary $'[2026-04-08T22:10:00Z] [INFO] boot complete\n[2026-04-08T22:10:03Z] [ERROR] upstream timeout'
```

For plaintext requests:

- each non-empty line becomes one log entry
- `X-Log-Source`, `X-Log-Hostname`, `X-Log-Tags`, and `X-Log-Level` are optional
- simple prefixes like `ERROR something broke` and `[2026-04-08T22:10:03Z] [ERROR] something broke` are parsed automatically

You can also send an array:

```bash
curl -X POST http://localhost:3000/api/logs \
  -H "Content-Type: application/json" \
  -d '{
    "logs": [
      { "level": "info", "source": "api", "message": "Boot complete" },
      { "level": "warn", "source": "worker", "message": "Queue lag detected" }
    ]
  }'
```

### Read logs

```bash
curl "http://localhost:3000/api/logs?limit=100&level=error&source=payments-api&search=stripe"
```

### Clear logs

```bash
curl -X DELETE http://localhost:3000/api/logs
```

### Export logs

```bash
curl -OJ "http://localhost:3000/api/logs/export?format=json"
curl -OJ "http://localhost:3000/api/logs/export?format=csv"
```

## Coolify / Nixpacks

This repo includes `nixpacks.toml`, so Coolify can build it directly as a Bun app.

- Build system: `Nixpacks`
- Start command: `bun run start`
- Port: `3000` by default, or set `PORT`
- If using Redis in Coolify, provide `STORAGE_DRIVER=redis` and `REDIS_URL`
