const state = {
  pending: new Map(),
  reconnectTimer: null,
  socket: null,
  viewMode: "cards"
};

const elements = {
  clearButton: document.getElementById("clearButton"),
  curlExample: document.getElementById("curlExample"),
  emptyState: document.getElementById("emptyState"),
  exportCsvButton: document.getElementById("exportCsvButton"),
  exportJsonButton: document.getElementById("exportJsonButton"),
  lastUpdated: document.getElementById("lastUpdated"),
  levelFilter: document.getElementById("levelFilter"),
  limitInput: document.getElementById("limitInput"),
  logList: document.getElementById("logList"),
  logTemplate: document.getElementById("logTemplate"),
  refreshButton: document.getElementById("refreshButton"),
  searchInput: document.getElementById("searchInput"),
  socketStatusButton: document.getElementById("socketStatusButton"),
  sourceFilter: document.getElementById("sourceFilter"),
  statusPill: document.getElementById("statusPill"),
  storageDriver: document.getElementById("storageDriver"),
  totalLogs: document.getElementById("totalLogs"),
  rawLogView: document.getElementById("rawLogView"),
  viewModeButton: document.getElementById("viewModeButton"),
  visibleLogs: document.getElementById("visibleLogs")
};

elements.curlExample.textContent = `curl -X POST ${window.location.origin}/api/logs \\
  -H "Content-Type: application/json" \\
  -d '{"level":"info","source":"demo","message":"Server booted","metadata":{"region":"in"}}'`;

function getQuery() {
  const params = new URLSearchParams();
  const search = elements.searchInput.value.trim();
  const level = elements.levelFilter.value.trim();
  const source = elements.sourceFilter.value.trim();
  const limit = elements.limitInput.value || "250";

  params.set("limit", limit);
  if (search) params.set("search", search);
  if (level) params.set("level", level);
  if (source) params.set("source", source);
  return params;
}

function setStatus(label, mode = "idle") {
  elements.statusPill.textContent = label;
  elements.statusPill.dataset.mode = mode;
}

function setViewMode(mode) {
  state.viewMode = mode;
  const isRaw = mode === "raw";
  elements.viewModeButton.textContent = `View: ${isRaw ? "Raw" : "Cards"}`;
  elements.logList.classList.toggle("hidden", isRaw);
  elements.rawLogView.classList.toggle("hidden", !isRaw);
}

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
}

function renderLogs(logs) {
  elements.emptyState.classList.toggle("hidden", logs.length > 0);
  elements.logList.innerHTML = "";
  elements.rawLogView.textContent = logs.map((log) => JSON.stringify(log)).join("\n");

  for (const log of logs) {
    const node = elements.logTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".level-badge").textContent = log.level;
    node.querySelector(".level-badge").dataset.level = log.level;
    node.querySelector(".log-message").textContent = log.message;
    node.querySelector(".log-meta").textContent =
      `${formatDate(log.timestamp)}  •  ${log.source}${log.hostname ? `  •  ${log.hostname}` : ""}`;

    const tagRow = node.querySelector(".tag-row");
    if (log.tags.length) {
      for (const tag of log.tags) {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        chip.textContent = tag;
        tagRow.appendChild(chip);
      }
    } else {
      tagRow.remove();
    }

    const metadataBlock = node.querySelector(".metadata-block");
    const metadata = Object.keys(log.metadata).length ? JSON.stringify(log.metadata, null, 2) : "{}";
    metadataBlock.textContent = metadata;

    elements.logList.appendChild(node);
  }
}

function applySnapshot(payload) {
  renderLogs(payload.logs);
  elements.storageDriver.textContent = payload.store.driver;
  elements.totalLogs.textContent = String(payload.totalLogs);
  elements.visibleLogs.textContent = String(payload.visibleLogs);
  elements.lastUpdated.textContent = `Last updated ${new Date().toLocaleTimeString()}`;
  setStatus("Live", "ok");
}

function nextRequestId() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function setSocketStatus(label) {
  elements.socketStatusButton.textContent = `Socket: ${label}`;
}

function sendSocketMessage(message, { expectReply = false, timeoutMs = 6000 } = {}) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Socket is not connected."));
  }

  const payload = { ...message };
  if (!payload.requestId) {
    payload.requestId = nextRequestId();
  }

  state.socket.send(JSON.stringify(payload));

  if (!expectReply) {
    return Promise.resolve(payload.requestId);
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      state.pending.delete(payload.requestId);
      reject(new Error("Socket request timed out."));
    }, timeoutMs);

    state.pending.set(payload.requestId, {
      resolve,
      reject,
      timer
    });
  });
}

async function refreshNow() {
  try {
    setStatus("Refreshing", "loading");
    const payload = await sendSocketMessage(
      {
        type: "get_logs",
        ...Object.fromEntries(getQuery())
      },
      { expectReply: true }
    );
    applySnapshot(payload);
  } catch (error) {
    console.error(error);
    setStatus("Offline", "error");
    elements.lastUpdated.textContent = "Unable to load logs right now.";
  }
}

function downloadFile(filename, mimeType, content) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function exportLogs(format) {
  try {
    setStatus("Exporting", "loading");
    const payload = await sendSocketMessage(
      {
        type: "export_logs",
        format,
        ...Object.fromEntries(getQuery())
      },
      { expectReply: true, timeoutMs: 10000 }
    );
    downloadFile(payload.filename, payload.mimeType, payload.content);
    setStatus("Live", "ok");
  } catch (error) {
    console.error(error);
    setStatus("Export failed", "error");
  }
}

function connectSocket() {
  if (state.socket) {
    state.socket.close();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.socket = socket;
  setSocketStatus("Connecting");

  socket.addEventListener("open", () => {
    setSocketStatus("Live");
    setStatus("Live", "ok");
    window.clearTimeout(state.reconnectTimer);
    refreshNow();
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.requestId && state.pending.has(payload.requestId)) {
        const pending = state.pending.get(payload.requestId);
        window.clearTimeout(pending.timer);
        state.pending.delete(payload.requestId);

        if (payload.type === "error") {
          pending.reject(new Error(payload.error || "Socket request failed."));
          return;
        }

        pending.resolve(payload);
        return;
      }

      if (payload.totalLogs !== undefined) {
        elements.totalLogs.textContent = String(payload.totalLogs);
      }
      if (payload.store?.driver) {
        elements.storageDriver.textContent = payload.store.driver;
      }

      if (payload.type === "snapshot") {
        applySnapshot(payload);
        return;
      }

      if (payload.type === "invalidate") {
        refreshNow();
        return;
      }

      if (payload.type === "connected") {
        return;
      }

      if (payload.type === "cleared") {
        refreshNow();
      }
    } catch (error) {
      console.warn("Unable to parse socket payload", error);
    }
  });

  socket.addEventListener("close", () => {
    setSocketStatus("Retrying");
    setStatus("Reconnecting", "loading");
    for (const pending of state.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("Socket disconnected."));
    }
    state.pending.clear();
    state.reconnectTimer = window.setTimeout(connectSocket, 1500);
  });

  socket.addEventListener("error", () => {
    setSocketStatus("Error");
    setStatus("Socket error", "error");
  });
}

elements.refreshButton.addEventListener("click", refreshNow);
elements.viewModeButton.addEventListener("click", () => {
  setViewMode(state.viewMode === "cards" ? "raw" : "cards");
});
elements.exportJsonButton.addEventListener("click", () => exportLogs("json"));
elements.exportCsvButton.addEventListener("click", () => exportLogs("csv"));
elements.clearButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Clear all stored logs?");
  if (!confirmed) return;

  try {
    setStatus("Clearing", "loading");
    await sendSocketMessage({ type: "clear_logs" }, { expectReply: true });
    await refreshNow();
  } catch (error) {
    console.error(error);
    setStatus("Clear failed", "error");
  }
});

for (const element of [
  elements.searchInput,
  elements.levelFilter,
  elements.sourceFilter,
  elements.limitInput
]) {
  element.addEventListener("input", refreshNow);
  element.addEventListener("change", refreshNow);
}

setViewMode("cards");
connectSocket();
