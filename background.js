/* Service worker — bridges content scripts ↔ offscreen engine.
 * Manages the offscreen document lifecycle.
 */

const OFFSCREEN_URL = 'offscreen.html';

let creating = null; // dedupe concurrent creation attempts
let activeAnalyzerTabId = null; // last tab that requested analysis

async function hasOffscreenDoc() {
  if (chrome.offscreen?.hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  // Chrome < 116 fallback
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreenDoc()) return;

  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'Run Fairy-Stockfish WASM engine in a cross-origin isolated context'
  });
  try { await creating; } finally { creating = null; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // From content script (ISOLATED) → forward to offscreen
  if (msg.to === 'background') {
    if (msg.type === 'analyze') {
      activeAnalyzerTabId = sender.tab?.id ?? activeAnalyzerTabId;
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({
          to: 'offscreen',
          type: 'analyze',
          fen: msg.fen,
          engineId: msg.engineId || null,
          moveTime: msg.moveTime || null
        }))
        .catch(err => console.error('[XQ-BG] analyze relay failed:', err));
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'stop') {
      chrome.runtime.sendMessage({ to: 'offscreen', type: 'stop' }).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'listEngines') {
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ to: 'offscreen', type: 'listEngines' }))
        .catch(err => console.error('[XQ-BG] listEngines relay failed:', err));
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'preload') {
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({
          to: 'offscreen',
          type: 'preload',
          engineId: msg.engineId || null
        }))
        .catch(err => console.error('[XQ-BG] preload relay failed:', err));
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'recordPosition') {
      recordPosition(msg.data).catch(err => console.warn('[XQ-BG] record failed:', err));
      sendResponse({ ok: true });
      return true;
    }

    // From offscreen → forward to content script
    if (msg.type === 'engineReady' || msg.type === 'engineError' ||
        msg.type === 'engineLoading' || msg.type === 'engineList' ||
        msg.type === 'nnueProgress' || msg.type === 'engineLog' ||
        msg.type === 'analysisProgress' || msg.type === 'analysisDone') {
      relayToContent(msg);
      return;
    }
  }
});

// ---- Game recording ------------------------------------------------------
const GAMES_KEY = 'xq.games';

async function recordPosition(d) {
  if (!d || !d.gameId) return;
  if (d.moveCount == null) return; // skip if we don't know the move index
  const now = Date.now();
  const store = await chrome.storage.local.get(GAMES_KEY);
  const games = store[GAMES_KEY] || {};
  let game = games[d.gameId];
  if (!game) {
    game = {
      gameId: d.gameId,
      startTime: now,
      endTime: null,
      players: d.players || null,
      winner: null,
      result: null,
      endReason: null,
      lastState: null,
      moves: []
    };
  }
  if (d.players) game.players = d.players;
  if (d.winner) game.winner = d.winner;
  if (d.result) game.result = d.result;
  if (d.endReason) game.endReason = d.endReason;
  if (d.state != null) game.lastState = d.state;
  if (d.winner || d.result) game.endTime = game.endTime || now;

  // Find or append this position by moveCount
  const i = d.moveCount;
  let entry = game.moves.find(m => m.i === i);
  if (!entry) {
    entry = { i, t: now };
    game.moves.push(entry);
    game.moves.sort((a, b) => a.i - b.i);
  }
  if (d.fen) entry.fen = d.fen;
  if (d.turn) entry.turn = d.turn;
  if (d.lastMove) entry.uci = d.lastMove;
  if (d.eval) {
    entry.cp = d.eval.cp ?? entry.cp ?? null;
    entry.mate = d.eval.mate ?? entry.mate ?? null;
    entry.depth = d.eval.depth ?? entry.depth ?? null;
    entry.bestPv = d.eval.bestPv ?? entry.bestPv;
  }

  games[d.gameId] = game;
  await chrome.storage.local.set({ [GAMES_KEY]: games });
}

// ---- Dashboard entry -----------------------------------------------------
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

function relayToContent(msg) {
  // Broadcast to all xiangqi tabs (cheap; usually one active game)
  chrome.tabs.query({ url: '*://play.xiangqi.com/*' }, (tabs) => {
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { ...msg, to: 'content' }).catch(() => {});
    }
  });
}
