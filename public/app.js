/* AI Chatroom frontend: SSE-driven state + streaming render. */

const state = {
  hostName: "Host",
  participants: [],
  running: false,
  pausedReason: null,
  activeSpeakerId: null,
  waitingForHost: false,
  settings: { turnDelayMs: 2000, maxTokens: 2048, turnCap: 30 },
};

const els = {
  chat: document.getElementById("chat"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  btnToggle: document.getElementById("btn-toggle"),
  btnReset: document.getElementById("btn-reset"),
  participantList: document.getElementById("participant-list"),
  addForm: document.getElementById("add-form"),
  providerSelect: document.getElementById("provider-select"),
  modelInput: document.getElementById("model-input"),
  modelList: document.getElementById("model-list"),
  addError: document.getElementById("add-error"),
  composer: document.getElementById("composer"),
  composerInput: document.getElementById("composer-input"),
  setDelay: document.getElementById("set-delay"),
  setCap: document.getElementById("set-cap"),
  setTokens: document.getElementById("set-tokens"),
};

// message id -> { el, bodyEl, raw }
const bubbles = new Map();

/* ---------- helpers ---------- */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

function mdToHtml(text) {
  let html;
  try {
    html = marked.parse(text, { breaks: true });
  } catch {
    html = text;
  }
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content
    .querySelectorAll("script, style, iframe, object, embed, link, meta")
    .forEach((el) => el.remove());
  tpl.content.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      if (
        (name === "href" || name === "src") &&
        attr.value.trim().toLowerCase().startsWith("javascript:")
      ) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return tpl.innerHTML;
}

function isNearBottom() {
  const c = els.chat;
  return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
}

function scrollToBottom() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ---------- rendering ---------- */

function renderStatus() {
  const { running, pausedReason, waitingForHost } = state;
  els.statusDot.className = `dot ${
    running ? (waitingForHost ? "waiting" : "running") : "paused"
  }`;
  els.statusText.textContent = running
    ? waitingForHost
      ? "Waiting for you"
      : "Running"
    : pausedReason && pausedReason !== "paused" && pausedReason !== "reset"
      ? `Paused — ${pausedReason}`
      : "Paused";
  els.btnToggle.textContent = running ? "Pause" : "Start";
  els.btnToggle.classList.toggle("pause-mode", running);
}

function renderParticipants() {
  els.participantList.innerHTML = "";
  for (const p of state.participants) {
    const li = document.createElement("li");
    if (p.id === state.activeSpeakerId) li.classList.add("speaking");

    const dot = document.createElement("span");
    dot.className = "p-dot";
    dot.style.background = p.color;

    const name = document.createElement("span");
    name.className = "p-name";
    name.textContent = p.displayName;
    name.title = p.modelId;

    const model = document.createElement("span");
    model.className = "p-model";
    model.textContent = p.modelId;

    const remove = document.createElement("button");
    remove.className = "p-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${p.displayName}`);
    remove.onclick = () => api("DELETE", `/api/participants/${p.id}`).catch(() => {});

    li.append(dot, name, model);
    if (p.id === state.activeSpeakerId) {
      const tag = document.createElement("span");
      tag.className = "speaking-tag";
      tag.textContent = "speaking";
      li.append(tag);
    }
    li.append(remove);
    els.participantList.append(li);
  }
}

function renderSettings() {
  els.setDelay.value = state.settings.turnDelayMs / 1000;
  els.setCap.value = state.settings.turnCap;
  els.setTokens.value = state.settings.maxTokens;
}

function emptyHint() {
  const hint = document.createElement("div");
  hint.id = "empty-hint";
  hint.textContent =
    "Add one or more models, type a topic below, then press Start.";
  return hint;
}

function addBubble(message, streaming) {
  document.getElementById("empty-hint")?.remove();
  const pin = isNearBottom();

  const el = document.createElement("div");
  el.className = "msg";
  el.dataset.id = message.id;
  if (message.speakerId === null) el.classList.add("host");
  if (message.error) el.classList.add("error-msg");
  if (streaming) el.classList.add("streaming");
  el.style.borderLeftColor = message.color;

  const head = document.createElement("div");
  head.className = "msg-head";

  const name = document.createElement("span");
  name.className = "msg-name";
  name.style.color = message.color;
  name.textContent = message.speakerName;
  head.append(name);

  const p = state.participants.find((x) => x.id === message.speakerId);
  if (p) {
    const model = document.createElement("span");
    model.className = "msg-model";
    model.textContent = p.modelId;
    head.append(model);
  }

  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = fmtTime(message.ts);
  head.append(time);

  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = mdToHtml(message.text || "");

  el.append(head, body);
  els.chat.append(el);
  bubbles.set(message.id, { el, bodyEl: body, raw: message.text || "" });
  if (pin) scrollToBottom();
}

function renderAll(snapshot) {
  Object.assign(state, snapshot);
  bubbles.clear();
  els.chat.innerHTML = "";
  if (!snapshot.messages.length) els.chat.append(emptyHint());
  for (const msg of snapshot.messages) {
    addBubble(msg, msg.id && snapshot.activeSpeakerId === msg.speakerId && !msg.error && msg === snapshot.messages[snapshot.messages.length - 1] && snapshot.running);
  }
  renderStatus();
  renderParticipants();
  renderSettings();
  scrollToBottom();
}

/* ---------- SSE ---------- */

function connect() {
  const source = new EventSource("/api/events");

  source.onmessage = (e) => {
    const event = JSON.parse(e.data);
    switch (event.type) {
      case "state":
      case "reset":
        renderAll(event.state);
        break;

      case "participants":
        state.participants = event.participants;
        renderParticipants();
        break;

      case "settings":
        state.settings = event.settings;
        renderSettings();
        break;

      case "status":
        state.running = event.running;
        state.pausedReason = event.reason;
        if (!event.running) {
          state.activeSpeakerId = null;
          state.waitingForHost = false;
          renderParticipants();
        }
        renderStatus();
        break;

      case "waiting":
        state.waitingForHost = event.waiting;
        renderStatus();
        break;

      case "message": // host interjection
        addBubble(event.message, false);
        break;

      case "message_start":
        state.activeSpeakerId = event.message.speakerId;
        renderParticipants();
        addBubble(event.message, true);
        break;

      case "message_delta": {
        const b = bubbles.get(event.id);
        if (!b) break;
        const pin = isNearBottom();
        b.raw += event.delta;
        b.bodyEl.innerHTML = mdToHtml(b.raw);
        if (pin) scrollToBottom();
        break;
      }

      case "message_end": {
        const b = bubbles.get(event.id ?? event.message.id);
        state.activeSpeakerId = null;
        renderParticipants();
        if (b) {
          b.el.classList.remove("streaming");
          b.raw = event.message.text;
          b.bodyEl.innerHTML = mdToHtml(b.raw);
          if (event.message.error) b.el.classList.add("error-msg");
        } else {
          addBubble(event.message, false);
        }
        break;
      }

      case "message_cancelled": {
        const b = bubbles.get(event.id);
        if (b) {
          b.el.remove();
          bubbles.delete(event.id);
        }
        state.activeSpeakerId = null;
        renderParticipants();
        break;
      }
    }
  };

  source.onerror = () => {
    // EventSource auto-reconnects; on reconnect the server resends full state.
  };
}

/* ---------- controls ---------- */

const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

async function initProviders() {
  const providers = await api("GET", "/api/providers");
  els.providerSelect.innerHTML = "";
  for (const [key, label] of Object.entries(PROVIDER_LABELS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = providers[key] ? label : `${label} (no key)`;
    opt.disabled = !providers[key];
    els.providerSelect.append(opt);
  }
  const first = Object.keys(PROVIDER_LABELS).find((k) => providers[k]);
  if (first) {
    els.providerSelect.value = first;
    loadModels(first);
  }
}

async function loadModels(provider) {
  els.modelList.innerHTML = "";
  els.addError.textContent = "";
  try {
    const models = await api("GET", `/api/models?provider=${provider}`);
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      if (m.name && m.name !== m.id) opt.label = m.name;
      els.modelList.append(opt);
    }
  } catch (err) {
    els.addError.textContent = `Couldn't load models: ${err.message}`;
  }
}

els.providerSelect.onchange = () => loadModels(els.providerSelect.value);

els.addForm.onsubmit = async (e) => {
  e.preventDefault();
  els.addError.textContent = "";
  const modelId = els.modelInput.value.trim();
  if (!modelId) return;
  try {
    await api("POST", "/api/participants", {
      provider: els.providerSelect.value,
      modelId,
    });
    els.modelInput.value = "";
  } catch (err) {
    els.addError.textContent = err.message;
  }
};

els.btnToggle.onclick = async () => {
  try {
    await api("POST", "/api/control", {
      action: state.running ? "pause" : "start",
    });
  } catch (err) {
    els.addError.textContent = err.message;
  }
};

els.btnReset.onclick = async () => {
  if (!confirm("Clear the conversation? (Participants are kept; the transcript file is saved.)")) return;
  await api("POST", "/api/control", { action: "reset" }).catch(() => {});
};

els.composer.onsubmit = async (e) => {
  e.preventDefault();
  const text = els.composerInput.value.trim();
  if (!text) return;
  els.composerInput.value = "";
  await api("POST", "/api/message", { text }).catch(() => {});
};

els.composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

function bindSetting(input, key, transform) {
  input.onchange = () => {
    const value = transform(Number(input.value));
    if (!Number.isFinite(value)) return;
    api("PATCH", "/api/settings", { [key]: value }).catch(() => {});
  };
}
bindSetting(els.setDelay, "turnDelayMs", (v) => v * 1000);
bindSetting(els.setCap, "turnCap", (v) => v);
bindSetting(els.setTokens, "maxTokens", (v) => v);

/* ---------- boot ---------- */

connect();
initProviders();
