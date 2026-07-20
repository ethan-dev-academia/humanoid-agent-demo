// Diagnostic dashboard client. Subscribes to /ws, renders live snapshots and journal events.
// Vanilla ESM — no bundler.

const EMOTIONS = ['joy', 'sadness', 'anger', 'fear', 'surprise', 'disgust', 'trust'];
const POS_EMOTIONS = new Set(['joy', 'trust']);
const NEG_EMOTIONS = new Set(['sadness', 'anger', 'fear', 'disgust']);
const NEG_TAGS = new Set(['bitter', 'hurt', 'anger', 'sad', 'fear', 'disgust']);
const POS_TAGS = new Set(['fond', 'warm', 'joy', 'trust']);

const SERIES_LEN = 120;
const DRIFT_LEN = 60;
const EVENT_LEN = 200;

const state = {
  characterName: '—',
  latestSnapshots: new Map(),
  valenceSeries: new Map(),
  arousalSeries: new Map(),
  bondSeries: new Map(),
  driftSeries: new Map(),
  events: [],
  transcript: [],
};

const els = {
  characterName: document.getElementById('character-name'),
  appTitle: document.getElementById('app-title'),
  activePersons: document.getElementById('active-persons'),
  status: document.getElementById('status'),
  moodBrief: document.getElementById('mood-brief'),
  moodTimestamp: document.getElementById('mood-timestamp'),
  affectBars: document.getElementById('affect-bars'),
  driftValue: document.getElementById('drift-value'),
  driftSpark: document.getElementById('drift-spark'),
  valenceChart: document.getElementById('valence-chart'),
  arousalChart: document.getElementById('arousal-chart'),
  bondChart: document.getElementById('bond-chart'),
  memoryList: document.getElementById('memory-list'),
  eventLog: document.getElementById('event-log'),
  memoryBadge: document.getElementById('memory-badge'),
  eventBadge: document.getElementById('event-badge'),
};

// --- Tab switching ------------------------------------------------------------
// Fixed 16:9 viewport: only one tabpanel is visible at a time. Tabs are
// clickable and keyboard-addressable (1–4). All DOM elements stay mounted so
// the render helpers can keep writing to hidden panels without special-casing.

const tabOrder = ['affect', 'memory', 'transcript', 'journal'];

function activateTab(name) {
  if (!tabOrder.includes(name)) return;
  document.querySelectorAll('.tab').forEach((el) => {
    const on = el.dataset.tab === name;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tabpanel').forEach((el) => {
    const on = el.dataset.tab === name;
    el.classList.toggle('active', on);
    if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
  });
  // Re-render charts on activation so the canvas picks up the newly-visible
  // layout size (canvases inside display:none don't compute layout).
  if (name === 'affect') redrawAffectCharts();
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    const idx = Number.parseInt(e.key, 10);
    if (idx >= 1 && idx <= tabOrder.length) activateTab(tabOrder[idx - 1]);
  });
}

let cssVars = null;
function palette() {
  if (!cssVars) {
    const cs = getComputedStyle(document.documentElement);
    cssVars = {
      pos: cs.getPropertyValue('--pos').trim() || '#86efac',
      neg: cs.getPropertyValue('--neg').trim() || '#fca5a5',
      neutral: cs.getPropertyValue('--neutral').trim() || '#d1d1d6',
      accent: cs.getPropertyValue('--accent').trim() || '#7dd3fc',
      border: cs.getPropertyValue('--border').trim() || '#2a2a2e',
      panel: cs.getPropertyValue('--panel').trim() || '#111114',
      textMute: cs.getPropertyValue('--text-mute').trim() || '#8e8e93',
    };
  }
  return cssVars;
}

// --- WebSocket lifecycle ------------------------------------------------------

let ws = null;
let reconnectDelay = 2000;

function setStatus(stateStr) {
  if (!els.status) return;
  els.status.dataset.state = stateStr;
  els.status.textContent = stateStr;
}

function connect() {
  setStatus('connecting');
  try {
    ws = new WebSocket(`ws://${location.host}/ws`);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  ws.addEventListener('open', () => {
    reconnectDelay = 2000;
    setStatus('connected');
  });
  ws.addEventListener('close', () => {
    setStatus('disconnected');
    scheduleReconnect();
  });
  ws.addEventListener('error', () => {
    try { ws.close(); } catch {}
  });
  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    dispatch(msg);
  });
}

function scheduleReconnect() {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(10000, Math.floor(reconnectDelay * 1.5));
  setTimeout(connect, delay);
}

// --- Dispatch -----------------------------------------------------------------

function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.kind) {
    case 'hello': return onHello(msg);
    case 'snapshot': return onSnapshot(msg);
    case 'journal': return onJournal(msg);
    case 'transcript': return handleTranscript(msg);
  }
}

function handleTranscript(msg) {
  state.transcript.push({ timestamp: msg.timestamp, speaker: msg.speaker, text: msg.text });
  if (state.transcript.length > 100) state.transcript.shift();
  renderTranscriptEntry(msg);
  updateBadge('transcript-count', state.transcript.length);
}

function renderTranscriptEntry({ timestamp, speaker, text }) {
  const list = document.getElementById('transcript-list');
  if (!list) return;
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 10;
  const li = document.createElement('li');
  li.className = 'transcript-row';
  li.dataset.speaker = speaker;
  li.innerHTML =
    `<span class="transcript-speaker">${speaker === 'self' ? 'self' : 'other'}</span>` +
    `<span class="transcript-text">${escapeHtml(text)}</span>` +
    `<span class="transcript-time">${formatTime(timestamp)}</span>`;
  list.appendChild(li);
  while (list.children.length > 100) list.removeChild(list.firstElementChild);
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function updateBadge(id, count) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(count);
}

function onHello(msg) {
  state.characterName = msg.character ?? '—';
  if (els.characterName) els.characterName.textContent = state.characterName;
  if (els.appTitle && !els.appTitle.dataset.set) {
    els.appTitle.textContent = state.characterName;
    els.appTitle.dataset.set = '1';
  }
}

function onSnapshot({ personId, timestamp, snapshot }) {
  state.latestSnapshots.set(personId, snapshot);
  pushSeries(state.valenceSeries, personId, timestamp, snapshot.valence, SERIES_LEN);
  pushSeries(state.arousalSeries, personId, timestamp, snapshot.arousal, SERIES_LEN);
  pushSeries(state.bondSeries, personId, timestamp, snapshot.bond, SERIES_LEN);
  pushSeries(state.driftSeries, personId, timestamp, snapshot.baselineDrift, DRIFT_LEN);

  renderActivePersons();

  const active = state.latestSnapshots.keys().next().value;
  if (active !== undefined) {
    const snap = state.latestSnapshots.get(active);
    renderMoodBrief(snap);
    renderAffectBars(snap);
    renderDrift(snap, active);
    redrawAffectCharts();
    renderMemoryList(snap);
    updateBadge('memory-badge', (snap.topMemories || []).length);
  }
}

// Redraw the three affect-tab time-series charts. Called on every snapshot AND
// on tab activation (canvases hidden by display:none have zero layout size, so
// their prior draws show empty until we redraw once the tab is visible).
function redrawAffectCharts() {
  const active = state.latestSnapshots.keys().next().value;
  if (active === undefined) return;
  renderTimeSeriesChart(els.valenceChart, state.valenceSeries.get(active) || [], { axis: 'signed' });
  renderTimeSeriesChart(els.arousalChart, state.arousalSeries.get(active) || [], { axis: 'positive' });
  renderTimeSeriesChart(els.bondChart, state.bondSeries.get(active) || [], { axis: 'signed' });
  const snap = state.latestSnapshots.get(active);
  if (snap) renderDrift(snap, active);
}

function onJournal({ event }) {
  if (!event) return;
  state.events.push(event);
  if (state.events.length > EVENT_LEN) state.events.splice(0, state.events.length - EVENT_LEN);
  renderEventLog(event);
  updateBadge('event-badge', state.events.length);
}

function pushSeries(map, personId, t, v, maxLen) {
  let arr = map.get(personId);
  if (!arr) { arr = []; map.set(personId, arr); }
  arr.push({ t, v });
  if (arr.length > maxLen) arr.splice(0, arr.length - maxLen);
}

// --- Render -------------------------------------------------------------------

function renderActivePersons() {
  if (!els.activePersons) return;
  const ids = [...state.latestSnapshots.keys()];
  if (!ids.length) { els.activePersons.textContent = '—'; return; }
  els.activePersons.textContent = ids.map(shortId).join(', ');
}

function shortId(id) {
  return id.length > 8 ? id.slice(0, 8) + '…' : id;
}

/** Update the mood brief text and freshness stamp. */
function renderMoodBrief(snapshot) {
  if (els.moodBrief) els.moodBrief.textContent = snapshot.moodBrief ?? '—';
  if (els.moodTimestamp) {
    els.moodTimestamp.textContent = `updated ${formatRelative(Date.now() - snapshot.snapshotAt)} ago`;
  }
}

/** Fill each emotion row with drifted-baseline magnitude, color-coded by valence direction. */
function renderAffectBars(snapshot) {
  if (!els.affectBars) return;
  const baseline = snapshot.driftedBaseline || [];
  const empty = baseline.length === 0;
  const p = palette();

  for (let i = 0; i < EMOTIONS.length; i++) {
    const emo = EMOTIONS[i];
    const row = els.affectBars.querySelector(`.affect-row[data-emotion="${emo}"]`);
    if (!row) continue;
    const fill = row.querySelector('.affect-fill');
    const valueEl = row.querySelector('.affect-value');
    const v = baseline[i];

    if (empty || v === undefined) {
      if (valueEl) valueEl.textContent = '—';
      if (fill) { fill.style.width = '0%'; fill.style.left = '50%'; fill.style.background = 'transparent'; }
      continue;
    }

    if (valueEl) valueEl.textContent = v.toFixed(2);
    // Bar width scales magnitude up to 50% of the row (each side of midline).
    const w = Math.min(50, Math.abs(v) * 50);
    const left = v >= 0 ? 50 : 50 - w;

    // Color: surprise is always neutral; otherwise a value in the emotion's
    // "positive direction" reads --pos, opposite direction reads --neg.
    let color;
    if (v === 0) {
      color = 'transparent';
    } else if (emo === 'surprise') {
      color = p.neutral;
    } else if (POS_EMOTIONS.has(emo)) {
      color = v >= 0 ? p.pos : p.neg;
    } else if (NEG_EMOTIONS.has(emo)) {
      color = v >= 0 ? p.neg : p.pos;
    } else {
      color = p.neutral;
    }

    if (fill) {
      fill.style.width = `${w}%`;
      fill.style.left = `${left}%`;
      fill.style.background = color;
    }
  }
}

function renderDrift(snapshot, personId) {
  if (els.driftValue) els.driftValue.textContent = (snapshot.baselineDrift ?? 0).toFixed(3);
  const series = state.driftSeries.get(personId) || [];
  renderTimeSeriesChart(els.driftSpark, series, { axis: 'positive', spark: true });
}

/**
 * Draw a time-series polyline on a 2D canvas. Hand-rolled, no charting lib.
 * opts.axis: 'signed' (symmetric around zero) | 'positive' (min 0). Default: auto.
 * opts.spark: true → skip labels, minimal styling.
 */
function renderTimeSeriesChart(canvas, series, opts = {}) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const p = palette();

  ctx.clearRect(0, 0, w, h);

  if (!series.length) return;

  const values = series.map((s) => s.v);
  let min = Math.min(...values);
  let max = Math.max(...values);

  if (opts.axis === 'signed') {
    const m = Math.max(Math.abs(min), Math.abs(max), 0.1);
    min = -m; max = m;
  } else if (opts.axis === 'positive') {
    min = 0;
    max = Math.max(max, 0.1);
  }

  if (min === max) { min -= 0.5; max += 0.5; }
  // 10% padding on the range.
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;

  const padX = opts.spark ? 2 : 6;
  const padY = opts.spark ? 2 : 6;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;

  const xFor = (i) => padX + (series.length === 1 ? plotW : (i / (series.length - 1)) * plotW);
  const yFor = (v) => padY + plotH - ((v - min) / (max - min)) * plotH;

  // Midline at y=0 when the range crosses zero.
  if (min < 0 && max > 0) {
    const y0 = yFor(0);
    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, y0);
    ctx.lineTo(w - padX, y0);
    ctx.stroke();
  }

  // Filled area beneath the polyline.
  ctx.beginPath();
  ctx.moveTo(xFor(0), yFor(series[0].v));
  for (let i = 1; i < series.length; i++) ctx.lineTo(xFor(i), yFor(series[i].v));
  ctx.lineTo(xFor(series.length - 1), padY + plotH);
  ctx.lineTo(xFor(0), padY + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(125, 211, 252, 0.08)';
  ctx.fill();

  // Polyline.
  ctx.beginPath();
  ctx.moveTo(xFor(0), yFor(series[0].v));
  for (let i = 1; i < series.length; i++) ctx.lineTo(xFor(i), yFor(series[i].v));
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Latest-value dot at the right edge.
  const lastX = xFor(series.length - 1);
  const lastY = yFor(series[series.length - 1].v);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = p.accent;
  ctx.fill();

  if (!opts.spark) {
    ctx.fillStyle = p.textMute;
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(max.toFixed(2), w - 4, 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText(min.toFixed(2), w - 4, h - 2);
  }
}

/** Rebuild the memory list from the snapshot; assumes SDK-sorted by salience desc. */
function renderMemoryList(snapshot) {
  if (!els.memoryList) return;
  els.memoryList.innerHTML = '';
  const memories = snapshot.topMemories || [];
  for (const m of memories) {
    const li = document.createElement('li');
    li.className = 'memory-card';

    let tint = 'rgba(209, 209, 214, 0.1)';
    const tagLc = String(m.tag || '').toLowerCase();
    if (NEG_TAGS.has(tagLc)) tint = 'rgba(252, 165, 165, 0.15)';
    else if (POS_TAGS.has(tagLc)) tint = 'rgba(134, 239, 172, 0.15)';

    li.innerHTML =
      `<span class="mem-tag" data-tag="${escapeHtml(m.tag ?? '')}" style="background:${tint}">${escapeHtml(m.tag ?? '')}</span>` +
      `<div class="mem-content">${escapeHtml(m.content ?? '')}</div>` +
      `<div class="mem-meta">salience ${(m.salience ?? 0).toFixed(2)} · ${formatAge(m.ageMs ?? 0)}</div>`;
    els.memoryList.appendChild(li);
  }
}

/** Append a journal event row, trim to EVENT_LEN, preserve auto-scroll intent. */
function renderEventLog(event) {
  const log = els.eventLog;
  if (!log) return;

  const wasAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 10;

  const li = document.createElement('li');
  li.className = 'log-row';
  const payloadStr = safeShortJson(event.payload);
  li.innerHTML =
    `<span class="log-time">${escapeHtml(formatTime(event.timestamp))}</span>` +
    `<span class="log-module">${escapeHtml(event.module ?? '')}</span>` +
    `<span class="log-type">${escapeHtml(event.type ?? '')}</span>` +
    `<span class="log-payload">${escapeHtml(payloadStr)}</span>`;
  log.appendChild(li);

  while (log.children.length > EVENT_LEN) log.removeChild(log.firstChild);

  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}

// --- Helpers ------------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeShortJson(payload) {
  let s;
  try { s = JSON.stringify(payload); } catch { s = String(payload); }
  if (s === undefined) s = '';
  if (s.length > 120) s = s.slice(0, 119) + '…';
  return s;
}

function formatRelative(ms) {
  const abs = Math.max(0, Math.floor(ms));
  const s = Math.floor(abs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatAge(ms) {
  return formatRelative(ms);
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour12: false });
}

initTabs();
connect();
