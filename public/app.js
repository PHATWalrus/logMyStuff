const state = {
  socket: null
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

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
}

function renderLogs(logs) {
  elements.logList.innerHTML = "";
  elements.emptyState.classList.toggle("hidden", logs.length > 0);

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

async function fetchLogs() {
  setStatus("Refreshing", "loading");
  const response = await fetch(`/api/logs?${getQuery().toString()}`);
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  const payload = await response.json();
  renderLogs(payload.logs);
  elements.storageDriver.textContent = payload.store.driver;
  elements.totalLogs.textContent = String(payload.totalLogs);
  elements.visibleLogs.textContent = String(payload.visibleLogs);
  elements.lastUpdated.textContent = `Last updated ${new Date().toLocaleTimeString()}`;
  setStatus("Live", "ok");
}

async function refreshNow() {
  try {
    await fetchLogs();
  } catch (error) {
    console.error(error);
    setStatus("Offline", "error");
    elements.lastUpdated.textContent = "Unable to load logs right now.";
  }
}

function setSocketStatus(label) {
  elements.socketStatusButton.textContent = `Socket: ${label}`;
}

function exportLogs(format) {
  const url = `/api/logs/export?${getQuery().toString()}&format=${format}`;
  window.open(url, "_blank", "noopener,noreferrer");
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
  });

  socket.addEventListener("message", async (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.totalLogs !== undefined) {
        elements.totalLogs.textContent = String(payload.totalLogs);
      }
      if (payload.store?.driver) {
        elements.storageDriver.textContent = payload.store.driver;
      }
    } catch (error) {
      console.warn("Unable to parse socket payload", error);
    }

    await refreshNow();
  });

  socket.addEventListener("close", () => {
    setSocketStatus("Retrying");
    setStatus("Reconnecting", "loading");
    window.setTimeout(connectSocket, 1500);
  });

  socket.addEventListener("error", () => {
    setSocketStatus("Error");
    setStatus("Socket error", "error");
  });
}

elements.refreshButton.addEventListener("click", refreshNow);
elements.exportJsonButton.addEventListener("click", () => exportLogs("json"));
elements.exportCsvButton.addEventListener("click", () => exportLogs("csv"));
elements.clearButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Clear all stored logs?");
  if (!confirmed) return;

  setStatus("Clearing", "loading");
  const response = await fetch("/api/logs", { method: "DELETE" });
  if (!response.ok) {
    setStatus("Clear failed", "error");
    return;
  }
  await refreshNow();
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

refreshNow();
connectSocket();
