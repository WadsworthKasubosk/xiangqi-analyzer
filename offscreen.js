/* Engine driver — runs in offscreen document (cross-origin isolated).
 * Loads Fairy-Stockfish WASM, exposes UCI bridge over chrome.runtime messaging.
 */

const log = (...a) => console.log('[XQ-Engine]', ...a);

let engine = null;
let ready = false;
let pendingAnalyze = null;
let analysisActive = false;

// multipv index → latest info line
let currentLines = { 1: null, 2: null, 3: null };
let lastDepth = 0;

async function initEngine() {
  log('loading wasm...');
  engine = await Stockfish();
  log('module loaded');

  engine.addMessageListener(handleEngineLine);

  send('uci');
  send('setoption name UCI_Variant value xiangqi');
  send('setoption name MultiPV value 3');
  send('setoption name Threads value 1');
  send('setoption name Hash value 32');
  send('ucinewgame');
  send('isready');
}

function send(cmd) {
  if (!engine) return;
  engine.postMessage(cmd);
}

function handleEngineLine(line) {
  if (typeof line !== 'string') return;

  if (line === 'readyok') {
    if (!ready) {
      ready = true;
      log('engine ready');
      chrome.runtime.sendMessage({ to: 'background', type: 'engineReady' });
      if (pendingAnalyze) {
        const job = pendingAnalyze;
        pendingAnalyze = null;
        startAnalyze(job);
      }
    }
    return;
  }

  if (line.startsWith('bestmove')) {
    analysisActive = false;
    const lines = [1, 2, 3].map(i => currentLines[i]).filter(Boolean);
    chrome.runtime.sendMessage({
      to: 'background',
      type: 'analysisDone',
      depth: lastDepth,
      lines: lines.map(serializeLine)
    });
    return;
  }

  if (line.startsWith('info ') && line.includes(' multipv ') && line.includes(' pv ')) {
    const info = parseInfo(line);
    if (!info || !info.multipv) return;
    if (info.multipv < 1 || info.multipv > 3) return;
    currentLines[info.multipv] = info;
    if (info.depth) lastDepth = Math.max(lastDepth, info.depth);
    scheduleUpdate();
  }
}

function parseInfo(line) {
  const parts = line.split(/\s+/);
  const out = {};
  for (let i = 1; i < parts.length; i++) {
    const k = parts[i];
    switch (k) {
      case 'depth':    out.depth = +parts[++i]; break;
      case 'seldepth': out.seldepth = +parts[++i]; break;
      case 'multipv':  out.multipv = +parts[++i]; break;
      case 'nodes':    out.nodes = +parts[++i]; break;
      case 'nps':      out.nps = +parts[++i]; break;
      case 'time':     out.time = +parts[++i]; break;
      case 'score': {
        const t = parts[++i];
        const v = +parts[++i];
        if (t === 'cp') out.cp = v;
        else if (t === 'mate') out.mate = v;
        break;
      }
      case 'pv':
        out.pv = parts.slice(i + 1);
        return out;
    }
  }
  return out;
}

function serializeLine(info) {
  return {
    multipv: info.multipv,
    depth:   info.depth,
    cp:      info.cp,
    mate:    info.mate,
    pv:      info.pv || [],
  };
}

let updateTimer = null;
function scheduleUpdate() {
  if (updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = null;
    const lines = [1, 2, 3].map(i => currentLines[i]).filter(Boolean);
    if (lines.length === 0) return;
    chrome.runtime.sendMessage({
      to: 'background',
      type: 'analysisProgress',
      depth: lastDepth,
      lines: lines.map(serializeLine)
    });
  }, 120);
}

function startAnalyze({ fen, moveTime }) {
  if (!ready) {
    pendingAnalyze = { fen, moveTime };
    return;
  }
  if (analysisActive) {
    send('stop');
  }
  analysisActive = true;
  currentLines = { 1: null, 2: null, 3: null };
  lastDepth = 0;
  send(`position fen ${fen}`);
  send(`go movetime ${moveTime}`);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.to !== 'offscreen') return;
  if (msg.type === 'analyze') {
    startAnalyze({ fen: msg.fen, moveTime: msg.moveTime || 1000 });
  } else if (msg.type === 'stop') {
    if (analysisActive) {
      send('stop');
      analysisActive = false;
    }
  }
});

initEngine().catch(err => {
  console.error('[XQ-Engine] init failed:', err);
  chrome.runtime.sendMessage({ to: 'background', type: 'engineError', message: String(err && err.message || err) });
});
