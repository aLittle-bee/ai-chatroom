/* AI Chatroom frontend: SSE-driven state + streaming render. */

const state = {
  hostName: "Host",
  participants: [],
  running: false,
  pausedReason: null,
  activeSpeakerId: null,
  waitingForHost: false,
  turnsThisRun: 0,
  turnCounts: {},
  settings: { turnDelayMs: 2000, maxTokens: 2048, turnCap: 30 },
};

const els = {
  chat: document.getElementById("chat"),
  statusChip: document.getElementById("status-chip"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  turnCounter: document.getElementById("turn-counter"),
  btnToggle: document.getElementById("btn-toggle"),
  btnReset: document.getElementById("btn-reset"),
  participantList: document.getElementById("participant-list"),
  addToggle: document.getElementById("add-toggle"),
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
  els.statusChip.className = `pill ${running ? (waitingForHost ? "waiting" : "live") : ""}`;
  els.statusText.textContent = running
    ? waitingForHost
      ? "Floor to you"
      : "On air"
    : pausedReason && pausedReason !== "paused" && pausedReason !== "reset"
      ? `Standby — ${pausedReason}`
      : "Standby";
  els.btnToggle.textContent = running ? "Pause" : "Start";
  els.btnToggle.classList.toggle("pause-mode", running);
  renderTurnCounter();
}

function renderTurnCounter() {
  const n = state.turnsThisRun;
  const show = state.running || n > 0;
  els.turnCounter.hidden = !show;
  if (show) {
    els.turnCounter.textContent = `TURN ${String(n).padStart(2, "0")}/${state.settings.turnCap}`;
  }
}

function renderParticipants() {
  els.participantList.innerHTML = "";
  for (const p of state.participants) {
    const speaking = p.id === state.activeSpeakerId;
    const li = document.createElement("li");
    li.className = "vcard";
    if (speaking) li.classList.add("speaking");
    li.style.setProperty("--voice", p.color);

    const top = document.createElement("div");
    top.className = "top";
    const orb = document.createElement("span");
    orb.className = "orb";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = p.displayName;
    nm.title = p.modelId;
    const remove = document.createElement("button");
    remove.className = "p-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${p.displayName}`);
    remove.onclick = () => api("DELETE", `/api/participants/${p.id}`).catch(() => {});
    top.append(orb, nm, remove);

    const id = document.createElement("div");
    id.className = "id";
    id.textContent = p.modelId;

    const stat = document.createElement("div");
    stat.className = "stat";
    const label = document.createElement("span");
    label.textContent = speaking ? "Speaking now…" : "Turns taken";
    const count = document.createElement("b");
    count.textContent = String(state.turnCounts[p.id] || 0).padStart(2, "0");
    stat.append(label, count);

    li.append(top, id, stat);
    els.participantList.append(li);
  }
}

function renderSettings() {
  els.setDelay.value = state.settings.turnDelayMs / 1000;
  els.setCap.value = state.settings.turnCap;
  els.setTokens.value = state.settings.maxTokens;
  renderTurnCounter();
}

function emptyHint() {
  const hint = document.createElement("div");
  hint.id = "empty-hint";
  const title = document.createElement("div");
  title.className = "rm-title";
  title.textContent = "The room is quiet.";
  const steps = document.createElement("div");
  steps.className = "steps";
  steps.innerHTML =
    "01&nbsp;&nbsp;<b>add models to the room</b> — mix providers freely<br>" +
    "02&nbsp;&nbsp;<b>seed a topic</b> in the composer below<br>" +
    "03&nbsp;&nbsp;<b>press start</b> and watch them talk — interject anytime";
  hint.append(title, steps);
  return hint;
}

function addBubble(message, streaming) {
  document.getElementById("empty-hint")?.remove();
  const pin = isNearBottom();
  const isFirst = bubbles.size === 0;

  const el = document.createElement("div");
  el.className = "m";
  el.dataset.id = message.id;
  if (message.error) el.classList.add("error-msg");
  if (streaming) el.classList.add("streaming");
  el.style.setProperty("--voice", message.color);

  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = mdToHtml(message.text || "");

  if (message.speakerId === null) {
    // host: raised directive card
    el.classList.add("host");
    const topic = document.createElement("div");
    topic.className = "topic";
    const k = document.createElement("div");
    k.className = "k";
    const label = document.createElement("span");
    label.textContent = isFirst
      ? `Topic — set by ${message.speakerName}`
      : message.speakerName;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = fmtTime(message.ts);
    k.append(label, meta);
    topic.append(k, body);
    el.append(topic);
  } else {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = (message.speakerName[0] || "?").toUpperCase();

    const main = document.createElement("div");
    main.className = "m-main";
    const head = document.createElement("div");
    head.className = "head";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = message.speakerName;
    const meta = document.createElement("span");
    meta.className = "meta";
    const p = state.participants.find((x) => x.id === message.speakerId);
    meta.textContent = p ? `${p.modelId} · ${fmtTime(message.ts)}` : fmtTime(message.ts);
    head.append(nm, meta);
    main.append(head, body);
    el.append(avatar, main);
  }

  els.chat.append(el);
  bubbles.set(message.id, { el, bodyEl: body, raw: message.text || "" });
  if (pin) scrollToBottom();
}

function recountTurns(messages) {
  state.turnCounts = {};
  for (const m of messages) {
    if (m.speakerId) {
      state.turnCounts[m.speakerId] = (state.turnCounts[m.speakerId] || 0) + 1;
    }
  }
}

function renderAll(snapshot) {
  Object.assign(state, snapshot);
  recountTurns(snapshot.messages);
  bubbles.clear();
  els.chat.innerHTML = "";
  if (!snapshot.messages.length) els.chat.append(emptyHint());
  for (const msg of snapshot.messages) addBubble(msg, false);
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
        if (event.running) state.turnsThisRun = 0;
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
        const speakerId = event.message.speakerId;
        if (speakerId) {
          state.turnCounts[speakerId] = (state.turnCounts[speakerId] || 0) + 1;
        }
        state.activeSpeakerId = null;
        state.turnsThisRun += 1;
        renderParticipants();
        renderStatus();
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

els.addToggle.onclick = () => {
  els.addForm.hidden = !els.addForm.hidden;
  if (!els.addForm.hidden) els.modelInput.focus();
};

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
    els.addForm.hidden = false;
    els.addError.textContent = err.message;
  }
};

els.btnReset.onclick = async () => {
  if (!confirm("Clear the conversation? (The cast is kept; the transcript file is saved.)")) return;
  await api("POST", "/api/control", { action: "reset" }).catch(() => {});
};

els.composer.onsubmit = async (e) => {
  e.preventDefault();
  const text = els.composerInput.value.trim();
  if (!text) return;
  els.composerInput.value = "";
  els.composerInput.style.height = "";
  await api("POST", "/api/message", { text }).catch(() => {});
};

els.composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

// grow the composer with its content (capped in CSS)
els.composerInput.addEventListener("input", () => {
  const t = els.composerInput;
  t.style.height = "";
  t.style.height = `${t.scrollHeight}px`;
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
