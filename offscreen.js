/* Engine driver — runs in offscreen document (cross-origin isolated).
 *
 * Multi-engine architecture:
 *   - ENGINES: declarative registry of available engines/profiles
 *   - EngineInstance: one loaded engine (script + module + UCI state)
 *   - instances Map: id → EngineInstance, lazy-loaded and cached
 *   - activeId: currently selected engine; analyze requests route here
 *
 * Adding a new engine = one entry in ENGINES + drop the WASM/JS in engine/.
 * No other file needs to change.
 */

const log = (...a) => {
  console.log('[XQ-Engine]', ...a);
  try {
    const line = a.map(v => {
      if (typeof v === 'string') return v;
      if (v instanceof Error) return v.stack || v.message;
      try { return JSON.stringify(v); } catch (_) { return String(v); }
    }).join(' ');
    chrome.runtime.sendMessage({ type: 'engineLog', line }).catch(() => {});
  } catch (_) {}
};

// Engine workers (Emscripten pthreads) throw to window via ErrorEvent. Chrome
// renders the bare event as "Uncaught ErrorEvent" with no detail — useless
// for diagnosing why Pikafish dies on first analyze. Unwrap the event so we
// see filename/lineno/message/stack.
window.addEventListener('error', (e) => {
  const detail = e.error && e.error.stack
    ? e.error.stack
    : `${e.message || '(no message)'} @ ${e.filename || '?'}:${e.lineno || '?'}:${e.colno || '?'}`;
  log('window error:', detail);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  log('unhandled rejection:', r && r.stack ? r.stack : (r && r.message) || r);
});

const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;

// 同一份 binary 可以注册多个 profile;UI 把它们当独立 "engine" 选。
// evalFile 给 Fairy-Stockfish 喂 NNUE 文件——比 HCE 评估强一档。
// 加 Pikafish 时取消下面那块注释,把文件丢到 engine/pikafish.* 即可。
const FAIRY_NNUE = {
  url: 'engine/xiangqi-c07e94a5c7cb.nnue',
  name: 'xiangqi-c07e94a5c7cb.nnue',
};
const ENGINES = [
  {
    id: 'fairy-fast',
    name: 'Fairy-Stockfish · 快速',
    desc: '1.5s · 半数核心 · 64MB hash · NNUE — 业余对局够用',
    scriptUrl: 'engine/stockfish.js',
    factoryGlobal: 'Stockfish',
    threads: Math.max(1, Math.min(4, Math.floor(cores / 2))),
    moveTime: 1500,
    evalFile: FAIRY_NNUE,
    options: {
      UCI_Variant: 'xiangqi',
      MultiPV: 3,
      Hash: 64,
      EvalFile: FAIRY_NNUE.name,
    },
  },
  {
    id: 'fairy-strong',
    name: 'Fairy-Stockfish · 深算',
    desc: '5s · 全核 · 512MB hash · NNUE — 关键局面',
    scriptUrl: 'engine/stockfish.js',
    factoryGlobal: 'Stockfish',
    threads: Math.max(1, Math.min(8, cores - 1)),
    moveTime: 5000,
    evalFile: FAIRY_NNUE,
    options: {
      UCI_Variant: 'xiangqi',
      MultiPV: 3,
      Hash: 512,
      EvalFile: FAIRY_NNUE.name,
    },
  },
  {
    id: 'pikafish',
    name: 'Pikafish (NNUE)',
    desc: '3s · 单线程 · 128MB · 官方象棋 NN 引擎 — 比 Fairy 再强一档',
    scriptUrl: 'engine/pikafish.js',
    factoryGlobal: 'Pikafish',
    // 以下参数是 Node smoke-test 实测最优组合(见 tools/pikafish-smoke/):
    //   Threads=1 / movetime=3000 / Hash=128MB
    //
    // Threads 为什么固定 1:
    //   • Threads=2/4 都崩:wasm-function[533] Aborted,这个 pikafish WASM
    //     build 的多线程搜索本身就不稳(没做 SIMD,pthread 栈管理有 bug)
    //   • 浏览器里动态改 Threads 还会重建 pthread 池,新 worker MEMFS 看不到
    //     preRun 写的 /pikafish.nnue → "Network file not loaded" engine terminated
    //
    // movetime=3000 为什么:
    //   • 2s→depth 14 (score 94), 3s→depth 15 (score 101)
    //   • 3s 之后 depth 卡 15 不动,加时间只多搜节点,分数几乎不变
    //
    // Hash=128 为什么:
    //   • 3s 短搜索 hashfull 只到 9‰,64/128/256 结果一样
    //   • 128 nps 微高(48581),512 反而倒退到 depth 14(allocation 开销)
    threads: 1,
    moveTime: 3000,
    // Pikafish dev-20260418 换用了新架构的 small net(11MB),文件名里的
    // c07e94a5c7cb 就是引擎里硬编码的架构哈希。老版 master-net (51MB,
    // 'pikafish.nnue')跟这版引擎不兼容,go 时会 "Network file not loaded
    // successfully" 然后 terminate,整个 pikafish 就哑了。
    evalFile: { url: 'engine/xiangqi-c07e94a5c7cb.nnue', name: 'xiangqi-c07e94a5c7cb.nnue' },
    options: {
      // Pikafish 是专用象棋引擎,没有 UCI_Variant
      MultiPV: 3,
      Hash: 128,
      // Engine error message hints "specify the full path, including the
      // directory name". Try absolute path to dodge per-thread cwd quirks.
      EvalFile: '/xiangqi-c07e94a5c7cb.nnue',
    },
  },
];

const ENGINE_BY_ID = Object.fromEntries(ENGINES.map(e => [e.id, e]));
const DEFAULT_ENGINE_ID = ENGINES[0].id;

// One-shot script injection cache. Two engines sharing the same scriptUrl
// (different profiles of Fairy-Stockfish) only inject once.
const loadedScripts = new Map(); // url → Promise<void>
function loadScript(url) {
  if (loadedScripts.has(url)) return loadedScripts.get(url);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
  loadedScripts.set(url, p);
  return p;
}

// ---- IndexedDB 持久缓存(解压后的 NNUE 字节)---------------------------
// offscreen doc 空闲会被 Chrome 回收,内存里的 nnueCache 每次都清零。把
// *解压后* 的字节落到 IDB,下次启动直接拿,省掉 51MB→150MB 的 zstd 解压
// 与字节拼接(实测 ~3-5s 的纯 JS CPU 时间)。
// Key 带 manifest 版本号,升级插件时旧缓存自然被忽略——避免 NNUE 文件换
// 了但用户拿到旧字节导致引擎行为异常。
const NNUE_DB_NAME = 'xq-nnue-cache';
const NNUE_STORE = 'nnue';
const NNUE_VERSION = (() => {
  try { return chrome.runtime.getManifest().version || '0'; }
  catch (_) { return '0'; }
})();
function nnueCacheKey(url) { return `${url}@${NNUE_VERSION}`; }

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NNUE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NNUE_STORE)) {
        db.createObjectStore(NNUE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NNUE_STORE, 'readonly');
    const req = tx.objectStore(NNUE_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NNUE_STORE, 'readwrite');
    tx.objectStore(NNUE_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// NNUE byte cache. Two profiles of the same engine share one blob (Fairy
// shares ~10MB; Pikafish has its own ~50MB). Streams via ReadableStream so
// the UI can show real progress instead of a spinner that lies for 5-10s.
const nnueCache = new Map(); // url → Promise<Uint8Array>
function loadNnue(url, engineId) {
  if (nnueCache.has(url)) return nnueCache.get(url);
  const p = (async () => {
    // 优先查 IDB 缓存。命中 = 直接拿到解压后的字节,省掉 fetch + zstd.
    const key = nnueCacheKey(url);
    try {
      const hit = await idbGet(key);
      if (hit instanceof Uint8Array && hit.length > 0) {
        log(`NNUE cache hit ${key}: ${(hit.length / 1048576).toFixed(2)}MB (skipped fetch+decompress)`);
        publish({ type: 'nnueProgress', engineId, loaded: hit.length, total: hit.length });
        return hit;
      }
    } catch (e) {
      // IDB 读失败不是致命错误,降级到网络路径即可。只打一条日志,下次
      // 还可能成功。
      log(`NNUE cache read failed (${e && e.message || e}) — falling back to fetch`);
    }

    log(`fetching NNUE ${url}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NNUE fetch ${url} → ${res.status}`);
    const total = +res.headers.get('content-length') || 0;
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    let raw;
    if (!reader) {
      // fallback if streaming unsupported
      const buf = await res.arrayBuffer();
      publish({ type: 'nnueProgress', engineId, loaded: buf.byteLength, total: buf.byteLength });
      raw = new Uint8Array(buf);
    } else {
      const chunks = [];
      let loaded = 0;
      let lastSent = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        // Throttle progress messages to ~60ms so we don't flood the message bus.
        const now = Date.now();
        if (now - lastSent > 60) {
          lastSent = now;
          publish({ type: 'nnueProgress', engineId, loaded, total });
        }
      }
      publish({ type: 'nnueProgress', engineId, loaded, total: total || loaded });
      log(`NNUE loaded: ${(loaded / 1048576).toFixed(2)}MB`);
      raw = new Uint8Array(loaded);
      let offset = 0;
      for (const c of chunks) { raw.set(c, offset); offset += c.byteLength; }
    }
    const decompressed = await maybeDecompress(raw);
    // Fire-and-forget 落盘:不 await,避免阻塞引擎初始化。写失败只打 log,
    // 下次照常走网络路径。
    idbPut(key, decompressed).then(
      () => log(`NNUE persisted to IDB ${key} (${(decompressed.length / 1048576).toFixed(2)}MB)`),
      (e) => log(`NNUE persist failed (${e && e.message || e})`)
    );
    return decompressed;
  })();
  nnueCache.set(url, p);
  return p;
}

// Pikafish (and many other engines) ship NNUE files compressed with zstd to
// cut download size ~3x. The engine itself doesn't decompress — it expects
// raw bytes — so feeding the compressed blob causes a "memory access out of
// bounds" trap on first eval. Detect the zstd magic (28 b5 2f fd) and
// decompress via fzstd before writing to MEMFS.
//
// Why fzstd and not DecompressionStream('zstd'): Chrome's DecompressionStream
// silently hangs in offscreen documents — constructor accepts 'zstd' without
// throwing, but the stream never produces output. fzstd is ~8KB pure JS,
// synchronous, and just works.
function maybeDecompress(bytes) {
  if (bytes.length < 4) return bytes;
  const isZstd = bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
  if (!isZstd) return bytes;
  if (typeof fzstd === 'undefined' || typeof fzstd.decompress !== 'function') {
    throw new Error('NNUE is zstd-compressed but fzstd is not loaded (check offscreen.html)');
  }
  log(`NNUE is zstd-compressed (${(bytes.length / 1048576).toFixed(2)}MB), decompressing with fzstd...`);
  const t0 = performance.now();
  const out = fzstd.decompress(bytes);
  log(`NNUE decompressed → ${(out.length / 1048576).toFixed(2)}MB in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
  return out;
}

class EngineInstance {
  constructor(spec) {
    this.spec = spec;
    this.id = spec.id;
    this.module = null;
    this.ready = false;
    this.loadPromise = null;
    this.analysisActive = false;
    this.currentLines = { 1: null, 2: null, 3: null };
    this.lastDepth = 0;
    this.updateTimer = null;
    // Each engine needs its own callback target so stale info from a
    // just-deactivated engine doesn't reach the UI.
    this.publish = null; // set by router
  }

  async load() {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      const t0 = performance.now();
      log(`loading ${this.id} (${this.spec.scriptUrl})...`);
      const [_, nnueBytes] = await Promise.all([
        loadScript(this.spec.scriptUrl),
        this.spec.evalFile ? loadNnue(this.spec.evalFile.url, this.id) : Promise.resolve(null),
      ]);
      log(`${this.id}: script+NNUE fetched in ${((performance.now() - t0) / 1000).toFixed(2)}s, instantiating WASM...`);
      const factory = window[this.spec.factoryGlobal];
      if (typeof factory !== 'function') {
        throw new Error(`global ${this.spec.factoryGlobal} not found after loading ${this.spec.scriptUrl}`);
      }

      const t1 = performance.now();
      // Write NNUE via preRun (not post-factory) because Pikafish runs main()
      // on a pthread worker (PROXY_TO_PTHREAD-style). A post-factory
      // writeFile lands in the main thread's FS but the worker has already
      // initialized its own FS view by then — the engine's fopen() inside
      // the worker can't see the file and reports "Network file pikafish.nnue
      // was not loaded successfully". preRun executes before runtime init on
      // every thread, so the FS entry is visible everywhere.
      const id = this.id;
      const evalSpec = this.spec.evalFile;
      this.module = await factory({
        onAbort: (what) => log(`${id} ABORT:`, what),
        preRun: nnueBytes && evalSpec ? [(M) => {
          const t2 = performance.now();
          // Write NNUE to root. Also try to mkdir + write under /home/web_user
          // since Emscripten sometimes defaults cwd there and the engine's
          // fopen of a relative path could resolve differently per-thread.
          M.FS.writeFile('/' + evalSpec.name, nnueBytes);
          try {
            M.FS.mkdirTree('/home/web_user');
          } catch (_) { /* exists */ }
          try {
            M.FS.writeFile('/home/web_user/' + evalSpec.name, nnueBytes);
          } catch (e) {
            log(`${id}: could not also write to /home/web_user (${e && e.message || e})`);
          }
          log(`${id}: NNUE written to MEMFS as '/${evalSpec.name}' + '/home/web_user/${evalSpec.name}' (${nnueBytes.length} bytes) in preRun, took ${((performance.now() - t2) / 1000).toFixed(2)}s`);
        }] : undefined,
      });
      log(`${this.id}: WASM instantiated in ${((performance.now() - t1) / 1000).toFixed(2)}s`);
      // Diag: confirm the NNUE actually landed somewhere the engine can see.
      try {
        const root = this.module.FS.readdir('/');
        log(`${this.id}: FS / contents: ${root.join(', ')}`);
        if (evalSpec) {
          const stat = this.module.FS.stat('/' + evalSpec.name);
          log(`${this.id}: FS stat /${evalSpec.name} → size=${stat.size}, mode=${stat.mode.toString(8)}`);
        }
        const cwd = this.module.FS.cwd ? this.module.FS.cwd() : '?';
        log(`${this.id}: FS cwd = ${cwd}`);
      } catch (err) {
        log(`${this.id}: FS diag failed: ${err && err.message || err}`);
      }
      this.module.addMessageListener((line) => this._onLine(line));
      this._send('uci');
      for (const [k, v] of Object.entries(this.spec.options || {})) {
        this._send(`setoption name ${k} value ${v}`);
      }
      this._send(`setoption name Threads value ${this.spec.threads}`);
      this._send('ucinewgame');
      log(`${this.id}: sent uci + setoptions + ucinewgame (threads=${this.spec.threads}), waiting for readyok...`);
      const t3 = performance.now();
      // Pikafish 第一次 isready 需要 fopen + 解析 50MB NNUE,冷启动在弱机
      // 上能到 20-30s。给 40s 余量,真死了再报。
      await this._waitReady(40000);
      this.ready = true;
      log(`${this.id} ready in ${((performance.now() - t3) / 1000).toFixed(2)}s (total ${((performance.now() - t0) / 1000).toFixed(2)}s; threads=${this.spec.threads}, hash=${this.spec.options.Hash}MB, nnue=${!!nnueBytes})`);
    })();
    return this.loadPromise;
  }

  _waitReady(timeoutMs) {
    return new Promise((resolve, reject) => {
      const to = timeoutMs ? setTimeout(() => {
        this._readyResolve = null;
        reject(new Error(`${this.id}: timed out waiting for readyok after ${timeoutMs}ms — engine likely failed silently (NNUE mismatch? thread spawn failed?)`));
      }, timeoutMs) : null;
      this._readyResolve = () => {
        if (to) clearTimeout(to);
        resolve();
      };
      this._send('isready');
    });
  }

  _send(cmd) {
    if (!this.module) return;
    if (!this.ready) log(`${this.id} >> ${cmd}`);
    this.module.postMessage(cmd);
  }

  _onLine(line) {
    if (typeof line !== 'string') return;

    // During loading, surface every line from the engine — otherwise silent
    // failures (NNUE version mismatch, worker spawn error, unknown setoption)
    // look identical to "still loading".
    if (!this.ready && line !== 'readyok') {
      log(`${this.id} << ${line}`);
    }

    if (line === 'readyok') {
      if (this._readyResolve) {
        const r = this._readyResolve;
        this._readyResolve = null;
        r();
      }
      return;
    }

    // Drop info/bestmove if no one is listening (engine was deactivated
    // mid-search; old results would mislabel the UI).
    if (!this.publish) return;

    if (line.startsWith('bestmove')) {
      this.analysisActive = false;
      const lines = [1, 2, 3].map(i => this.currentLines[i]).filter(Boolean);
      this.publish({
        type: 'analysisDone',
        engineId: this.id,
        depth: this.lastDepth,
        lines: lines.map(serializeLine),
      });
      return;
    }

    if (line.startsWith('info ') && line.includes(' multipv ') && line.includes(' pv ')) {
      const info = parseInfo(line);
      if (!info || !info.multipv) return;
      if (info.multipv < 1 || info.multipv > 3) return;
      this.currentLines[info.multipv] = info;
      if (info.depth) this.lastDepth = Math.max(this.lastDepth, info.depth);
      this._scheduleUpdate();
    }
  }

  _scheduleUpdate() {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      if (!this.publish) return;
      const lines = [1, 2, 3].map(i => this.currentLines[i]).filter(Boolean);
      if (lines.length === 0) return;
      this.publish({
        type: 'analysisProgress',
        engineId: this.id,
        depth: this.lastDepth,
        lines: lines.map(serializeLine),
      });
    }, 120);
  }

  startAnalyze(fen, moveTimeOverride) {
    if (this.analysisActive) this._send('stop');
    this.analysisActive = true;
    this.currentLines = { 1: null, 2: null, 3: null };
    this.lastDepth = 0;
    const mt = (moveTimeOverride && moveTimeOverride >= 100 && moveTimeOverride <= 60000)
      ? moveTimeOverride
      : this.spec.moveTime;
    this._send(`position fen ${normalizeFen(fen)}`);
    this._send(`go movetime ${mt}`);
  }

  stop() {
    if (this.analysisActive) {
      this._send('stop');
      this.analysisActive = false;
    }
  }
}

// play.xiangqi.com emits FENs with side-to-move 'r' (red). UCI standard is
// 'w' (white = side that moves first). Fairy-Stockfish with UCI_Variant=xiangqi
// tolerates both, but Pikafish strict-rejects 'r' with "Invalid side to move".
// Normalize at the engine boundary so callers can keep using the site's
// native format.
function normalizeFen(fen) {
  const parts = fen.split(' ');
  if (parts[1] === 'r') parts[1] = 'w';
  return parts.join(' ');
}

// ---- UCI parsing helpers ------------------------------------------------
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

// ---- Router -------------------------------------------------------------
const instances = new Map();
let activeId = null;
let pendingAnalyze = null; // queued FEN while target engine is loading

function publish(msg) {
  chrome.runtime.sendMessage({ to: 'background', ...msg });
}

async function ensureEngine(id) {
  const spec = ENGINE_BY_ID[id];
  if (!spec) throw new Error(`unknown engine: ${id}`);
  let inst = instances.get(id);
  if (!inst) {
    inst = new EngineInstance(spec);
    instances.set(id, inst);
    publish({ type: 'engineLoading', engineId: id });
  }
  await inst.load();
  return inst;
}

async function setActiveAndAnalyze(id, fen, moveTime) {
  const switching = activeId !== id;

  // Switching engines: detach old, stop its search, attach new.
  if (switching && activeId) {
    const old = instances.get(activeId);
    if (old) {
      old.stop();
      old.publish = null;
    }
  }

  let inst;
  try {
    inst = await ensureEngine(id);
  } catch (err) {
    publish({ type: 'engineError', engineId: id, message: String(err && err.message || err) });
    return;
  }

  // Bind the publish channel to this engine. Only its results reach the UI
  // until another switch occurs.
  inst.publish = publish;
  activeId = id;
  // Only signal engineReady on actual switch / first init. Otherwise content
  // would re-dispatch analyze on every ready, causing an infinite flicker.
  if (switching) {
    publish({ type: 'engineReady', engineId: id });
  }

  if (fen) inst.startAnalyze(fen, moveTime);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.to !== 'offscreen') return;

  if (msg.type === 'analyze') {
    const id = ENGINE_BY_ID[msg.engineId] ? msg.engineId : DEFAULT_ENGINE_ID;
    setActiveAndAnalyze(id, msg.fen, msg.moveTime).catch(err => {
      console.error('[XQ-Engine] analyze failed:', err);
    });
    return;
  }

  if (msg.type === 'stop') {
    const inst = activeId && instances.get(activeId);
    if (inst) inst.stop();
    return;
  }

  if (msg.type === 'listEngines') {
    publish({
      type: 'engineList',
      engines: ENGINES.map(e => ({
        id: e.id,
        name: e.name,
        desc: e.desc,
        moveTime: e.moveTime,
        threads: e.threads,
        hash: e.options.Hash,
      })),
      defaultId: DEFAULT_ENGINE_ID,
    });
    return;
  }

  // Warm up the engine the user has selected, before any FEN arrives. Without
  // this, offscreen would idle until the first dispatch, and a 51MB Pikafish
  // NNUE would only start downloading then — leaving the user staring at
  // "loading…" while they've already played 5+ moves.
  if (msg.type === 'preload') {
    const id = ENGINE_BY_ID[msg.engineId] ? msg.engineId : DEFAULT_ENGINE_ID;
    setActiveAndAnalyze(id, null).catch(err => {
      console.error('[XQ-Engine] preload failed:', err);
      publish({ type: 'engineError', engineId: id, message: String(err && err.message || err) });
    });
    return;
  }
});

// Note: no eager init here. Content script drives preload via the `preload`
// message once it has read the user's persisted engineId from localStorage.
// Otherwise we'd waste a load cycle on DEFAULT_ENGINE_ID when the user has
// actually selected a different engine.
