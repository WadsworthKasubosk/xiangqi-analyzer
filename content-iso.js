/* ISOLATED-world content script.
 * - Mounts the floating analysis panel
 * - Forwards FEN updates (received via CustomEvent from MAIN script) to background
 * - Receives analysis results from background and renders them
 */
(function () {
  if (window.__XQ_OVERLAY__) return;
  window.__XQ_OVERLAY__ = true;
  console.log('[XQ-Hint] content-iso boot v=hintdiag-3');

  const DEFAULT_MOVE_TIME = 3000; // fallback when engine list isn't loaded yet
  const PERSP_KEY = 'xq.perspective'; // 'auto' | 'red' | 'black'
  const ENGINE_KEY = 'xq.engine';     // selected engine id
  const HINT_KEY = 'xq.hint.on';      // '1' show board arrow / '0' hide
  const HINT_TUNE_KEY = 'xq.hint.tune'; // JSON {padX, padY} fractions of board rect
  const MATCH_KEY = 'xq.matchStats';   // per-game {gameId,total,top1,top3}
  // Per-engine movetime override. Keyed `xq.movetime.<engineId>` so each
  // engine remembers its own setting — Pikafish you'd push to 5s, Fairy-fast
  // you'd cut to 1s.
  const MT_KEY = (id) => `xq.movetime.${id}`;
  let availableEngines = [];          // [{id,name,desc,moveTime,...}]
  let selectedEngineId = null;
  // Last engine id we've already dispatched `preload` for. engineList handler
  // uses this to skip a second preload if nothing changed since the early
  // fire at mount time. Cleared on engine switch so every real change does
  // preload the new one.
  let preloadedEngineId = null;
  let selectedMoveTime = DEFAULT_MOVE_TIME;
  try {
    const saved = localStorage.getItem(ENGINE_KEY);
    if (saved) selectedEngineId = saved;
  } catch (_) {}
  let enabled = true;
  let currentFen = null;
  let currentTurn = 'red';
  let currentMeta = null; // full detail from xq:fen (for recording)
  // Perspective is what side the score is normalised to. 'auto' follows the
  // detected player side (bottom-avatar heuristic in content-main.js).
  let perspective = 'auto';
  try {
    const saved = localStorage.getItem(PERSP_KEY);
    if (saved === 'auto' || saved === 'red' || saved === 'black') perspective = saved;
  } catch (_) {}

  // Resolve perspective → a concrete 'red'|'black'. In 'auto' mode, follow
  // the detected playerSide; fall back to 'red' if unknown (initial load).
  function effectivePersp() {
    if (perspective !== 'auto') return perspective;
    return currentMeta?.playerSide || 'red';
  }

  // Whose turn is it relative to the player? Engine only runs on the
  // player's own turn — opponent-side suggestions are noise.
  function isMyTurn() {
    return currentTurn === effectivePersp();
  }
  let engineReady = false;
  let lastDispatchAt = 0;
  let pendingDispatch = null;
  // FEN that was most recently dispatched to the engine. Engine responses
  // arriving after the board has advanced (user or opponent moved) would
  // otherwise be rendered against the new currentFen and mislabel pieces.
  let analyzingFen = null;
  let analyzingTurn = null; // side-to-move when we dispatched
  // NNUE download progress is bucketed so the trace log doesn't get flooded
  // by 16-events-per-second updates. Reset when engine changes.
  let lastNnueLogEngine = null;
  let lastNnueLogBucket = -1;

  // -- 结构化日志 ----------------------------------------------------------
  // 环形缓冲 + 每个 FEN 一个 trace id。事件驱动附加,不改变分析链路,
  // 只多写一行 log。控制台访问:
  //   __xqLog.dump()           — 打表显示
  //   __xqLog.dump('engine')   — 按 evt 过滤
  //   __xqLog.download()       — 下载 JSON
  //   __xqLog.clear()
  // 也可以点浮层 ⤓ 按钮下载。默认 500 条封顶,一盘棋足够。
  const xqLog = (function () {
    const MAX = 500;
    const buf = [];
    let nextTrace = 1;
    function push(evt, data) {
      const entry = { t: Date.now(), evt, ...(data || {}) };
      buf.push(entry);
      if (buf.length > MAX) buf.shift();
      return entry;
    }
    function newTrace() { return nextTrace++; }
    function dump(filter) {
      const rows = filter ? buf.filter(e => e.evt === filter) : buf;
      console.table(rows.map(e => {
        const o = { time: new Date(e.t).toISOString().slice(11, 23), evt: e.evt };
        for (const [k, v] of Object.entries(e)) {
          if (k === 't' || k === 'evt') continue;
          o[k] = typeof v === 'object' ? JSON.stringify(v) : v;
        }
        return o;
      }));
      return rows;
    }
    function download() {
      const json = JSON.stringify(buf, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `xq-log-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function clear() { buf.length = 0; nextTrace = 1; }
    return { push, newTrace, dump, download, clear, get buf() { return buf; } };
  })();
  window.__xqLog = xqLog;
  let currentTrace = 0; // 当前 FEN 的 trace id,引擎结果沿用

  // 用户反馈:把吐槽和当时的 FEN / 最近一次分析结果打包成一条 log,
  // 而不是孤立一句话。复盘时能直接看到 "用户在这个局面下说了什么 +
  // 引擎当时给的是什么建议",不用靠时间戳自己翻前后日志对账。
  //
  // 用法:
  //   点浮层 ✎ 按钮
  //   或控制台 __xqLog.feedback('左马标反了')
  function recordFeedback(content) {
    const text = String(content || '').trim();
    if (!text) return null;
    const lines = (lastAnalysisMsg?.lines || [])
      .slice().sort((a, b) => a.multipv - b.multipv)
      .slice(0, 3)
      .map(l => {
        const pv = (l.pv || []).slice(0, 6);
        const zh = [];
        if (currentFen) {
          let b = fenToBoard(currentFen), t = currentTurn;
          for (const m of pv) {
            if (!m || m.length < 4) break;
            zh.push(uciToPlain(m, b));
            b = applyUci(b, m);
            t = t === 'red' ? 'black' : 'red';
          }
        }
        return {
          rank: l.multipv,
          cp: l.cp ?? null,
          mate: l.mate ?? null,
          uci: pv,
          zh
        };
      });
    const entry = xqLog.push('user-feedback', {
      feedback_from_user: true,
      content: text,
      trace: currentTrace,
      from_fen_where: currentFen,
      turn: currentTurn,
      playerSide: currentMeta?.playerSide || null,
      moveCount: currentMeta?.moveCount ?? null,
      lastMove: currentMeta?.lastMove || null,
      analysis: {
        final: lastAnalysisFinal,
        depth: lastAnalysisMsg?.depth ?? null,
        lines
      }
    });
    console.log('[XQ-Log] feedback recorded:', entry);
    return entry;
  }
  // 暴露到 __xqLog 命名空间,方便控制台一键反馈
  xqLog.feedback = recordFeedback;

  // -- DOM ----------------------------------------------------------------
  const root = document.createElement('div');
  root.id = 'xq-analyzer-root';
  root.innerHTML = `
    <div class="xq-header">
      <span class="xq-title" title="XQ Analyzer">XQ</span>
      <span class="xq-status" id="xq-status"><span class="xq-status-dot"></span><span class="xq-status-text">loading…</span></span>
      <div class="xq-actions">
        <button class="xq-btn" id="xq-persp" title="切换视角 (评分归一化到哪一方) 自动 → 红 → 黑">自动</button>
        <button class="xq-btn xq-btn-icon" id="xq-hint" title="在棋盘上画出引擎推荐的落子(从起点→终点) · 偏了就运行 __xqHintTune({padX, padY}) 微调">➤</button>
        <button class="xq-btn xq-btn-icon" id="xq-feedback" title="记录反馈(自动附带当前 FEN + 最近分析) · 控制台:__xqLog.feedback('内容')">✎</button>
        <button class="xq-btn xq-btn-icon" id="xq-log" title="下载完整日志 (JSON) · 控制台:__xqLog.dump()">⤓</button>
        <button class="xq-btn xq-btn-icon" id="xq-toggle" title="Pause/Resume">⏸</button>
        <button class="xq-btn xq-btn-icon" id="xq-collapse" title="Collapse">─</button>
      </div>
    </div>
    <div class="xq-body">
      <div class="xq-engine-row" title="切换分析引擎 — 切换瞬间会重新分析当前局面">
        <select class="xq-engine-sel" id="xq-engine"></select>
        <span class="xq-engine-desc" id="xq-engine-desc">—</span>
        <div class="xq-movetime-row" title="单步思考时长 — 长 = 棋力更强但响应更慢">
          <span class="xq-movetime-label">思考</span>
          <input class="xq-movetime-slider" id="xq-movetime" type="range" min="500" max="10000" step="250" value="3000">
          <span class="xq-movetime-val" id="xq-movetime-val">3.0s</span>
        </div>
        <div class="xq-engine-progress" id="xq-engine-progress"><div class="xq-engine-progress-bar"></div></div>
      </div>
      <div class="xq-score-row">
        <span class="xq-score" id="xq-score">—</span>
        <span class="xq-meta" id="xq-meta" title="评分视角 · 搜索深度 (正=对该视角方有利)">—·D0</span>
      </div>
      <div class="xq-evalbar" id="xq-evalbar" title="红方 vs 黑方 客观优势条 · 红在左 · 饱和于 ±500cp">
        <div class="xq-evalbar-fill" id="xq-evalbar-fill"></div>
      </div>
      <div class="xq-verdict" id="xq-verdict" title="结论 · 优势方 + 引擎首选着">
        <span class="xq-verdict-side" id="xq-verdict-side">—</span>
        <span class="xq-verdict-sep">·</span>
        <span class="xq-verdict-best" id="xq-verdict-best">等待分析…</span>
      </div>
      <div class="xq-mover-row">
        <div class="xq-mover" id="xq-mover" title="当前该哪一方走棋 · 下方建议即该方的着法">
          <span class="xq-mover-dot"></span>
          <span class="xq-mover-text">等待局面…</span>
        </div>
        <span class="xq-matchstat" id="xq-matchstat" title="我的走子和引擎首选重合度(本局) · 点击清零">—</span>
      </div>
      <div class="xq-flash" id="xq-flash"></div>
      <ol class="xq-lines" id="xq-lines">
        <li class="xq-empty">等待引擎…</li>
      </ol>
      <div class="xq-fen" id="xq-fen" title="当前喂给引擎的 FEN · 点击复制">—</div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const $ = (id) => document.getElementById(id);
  const statusEl = $('xq-status');
  const scoreEl = $('xq-score');
  const metaEl = $('xq-meta');
  const moverEl = $('xq-mover');
  const moverTextEl = moverEl?.querySelector('.xq-mover-text');
  const linesEl = $('xq-lines');
  const verdictEl = $('xq-verdict');
  const verdictSideEl = $('xq-verdict-side');
  const verdictBestEl = $('xq-verdict-best');
  const toggleBtn = $('xq-toggle');
  const collapseBtn = $('xq-collapse');
  const perspBtn = $('xq-persp');
  const logBtn = $('xq-log');
  const feedbackBtn = $('xq-feedback');
  const hintBtn = $('xq-hint');
  const fenEl = $('xq-fen');
  const engineSel = $('xq-engine');
  const engineDescEl = $('xq-engine-desc');
  const movetimeSlider = $('xq-movetime');
  const movetimeValEl = $('xq-movetime-val');
  const evalBarEl = $('xq-evalbar');
  const evalBarFillEl = $('xq-evalbar-fill');

  function renderEngineDropdown() {
    if (!engineSel) return;
    engineSel.innerHTML = '';
    for (const e of availableEngines) {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      opt.title = e.desc || '';
      if (e.id === selectedEngineId) opt.selected = true;
      engineSel.appendChild(opt);
    }
    updateEngineDesc();
    syncMovetimeFromEngine();
  }

  function updateEngineDesc() {
    if (!engineDescEl) return;
    const e = availableEngines.find(x => x.id === selectedEngineId);
    engineDescEl.textContent = e?.desc || '—';
  }

  // Pull the saved movetime for the selected engine (or its registry default
  // if the user hasn't customized) and reflect it in the slider.
  function syncMovetimeFromEngine() {
    if (!selectedEngineId) return;
    const e = availableEngines.find(x => x.id === selectedEngineId);
    let mt = e?.moveTime || DEFAULT_MOVE_TIME;
    try {
      const saved = localStorage.getItem(MT_KEY(selectedEngineId));
      if (saved && +saved >= 500 && +saved <= 10000) mt = +saved;
    } catch (_) {}
    selectedMoveTime = mt;
    if (movetimeSlider) movetimeSlider.value = String(mt);
    renderMovetimeLabel();
  }

  function renderMovetimeLabel() {
    if (!movetimeValEl) return;
    const s = (selectedMoveTime / 1000).toFixed(selectedMoveTime % 1000 === 0 ? 1 : 2);
    movetimeValEl.textContent = `${s}s`;
  }

  if (movetimeSlider) {
    // Live label update during drag, but only persist + log on `change`
    // (mouseup) so we don't write 40 storage entries per drag.
    movetimeSlider.addEventListener('input', () => {
      selectedMoveTime = +movetimeSlider.value || DEFAULT_MOVE_TIME;
      renderMovetimeLabel();
    });
    movetimeSlider.addEventListener('change', () => {
      const mt = +movetimeSlider.value || DEFAULT_MOVE_TIME;
      selectedMoveTime = mt;
      try { localStorage.setItem(MT_KEY(selectedEngineId), String(mt)); } catch (_) {}
      xqLog.push('movetime-change', { engineId: selectedEngineId, mt });
      // Re-dispatch with the new movetime so the user immediately sees the
      // effect on the current position. If we're not on our turn just stash.
      if (enabled && currentFen && isMyTurn()) requestAnalyze(currentFen);
    });
  }

  if (engineSel) {
    engineSel.addEventListener('change', () => {
      const id = engineSel.value;
      if (!id || id === selectedEngineId) return;
      const prev = selectedEngineId;
      selectedEngineId = id;
      try { localStorage.setItem(ENGINE_KEY, id); } catch (_) {}
      updateEngineDesc();
      syncMovetimeFromEngine();
      xqLog.push('engine-switch', { from: prev, to: id });
      // Re-analyze if it's our turn — that implicitly loads the new engine.
      // Otherwise still kick off a preload, so the engine is warm by the
      // time it's our turn (esp. relevant for Pikafish's 51MB NNUE).
      if (enabled && currentFen && isMyTurn()) {
        requestAnalyze(currentFen);
      } else {
        stopAnalyze();
        if (ctxAlive()) {
          try {
            chrome.runtime.sendMessage({
              to: 'background', type: 'preload', engineId: id
            }).catch(() => {});
            preloadedEngineId = id;
          } catch (_) {}
        }
      }
    });
  }

  if (logBtn) {
    logBtn.addEventListener('click', () => {
      xqLog.push('log-download', { size: xqLog.buf.length });
      xqLog.download();
      setStatus(`日志已保存 (${xqLog.buf.length})`, 'done');
    });
  }
  if (feedbackBtn) {
    feedbackBtn.addEventListener('click', () => {
      // 用原生 prompt 够用了 — 只要一行输入框,没必要自建模态框
      const hint = currentFen
        ? `当前局面 FEN(自动记录):\n${currentFen.split(' ')[0]}\n\n请输入反馈:`
        : '请输入反馈(当前无有效局面):';
      const text = window.prompt(hint, '');
      if (text == null) return; // 取消
      const entry = recordFeedback(text);
      if (entry) setStatus('反馈已记录', 'done');
      else setStatus('反馈为空', 'idle');
    });
  }

  fenEl.addEventListener('click', () => {
    if (!currentFen) return;
    try { navigator.clipboard.writeText(currentFen); } catch (_) {}
    setStatus('FEN 已复制', 'done');
  });

  // ---- 落子提示 (best-move arrow on real board) --------------------------
  // 在 play.xiangqi.com 自己的棋盘上画一个从起点到终点的箭头,让用户一眼
  // 看到引擎推荐。SVG 独立浮层,pointer-events:none,不拦截原站的点击。
  //
  // 网格标定方式:
  //   不去猜"棋盘容器有多少 padding"——站点外框/坐标字宽度没法一眼判定。
  //   直接在棋盘子树里扫棋子 DOM(单字中文或 <img alt="車">),棋子中心
  //   就是格点。再用 FEN 告诉我们哪些 file/rank 有棋子,反推一个 cell 有
  //   多大 + 文件 0 在哪。这样无论站点改了 UI、换了框线,都能自动贴合。
  //
  // 方向检测:
  //   站点让用户的棋子在下方。playerSide 从 fiber 里读不到时,扫到 "将"
  //   在屏幕上/下半 → 反推红下 / 黑下。UCI rank 0 始终是红方底线,站点
  //   翻棋盘时要把它画到屏幕上方。
  let showHint = true;
  try { showHint = localStorage.getItem(HINT_KEY) !== '0'; } catch (_) {}

  // 提示层 SVG — 挂在 <html> 上,fixed 定位,永远覆盖整个视口。
  // 显式 createElementNS 逐个建,不走 innerHTML:某些 Chrome 版本 + MV3
  // content script 下,对 SVG 根节点 innerHTML 赋值不会触发 SVG 片段解析,
  // 结果子节点是 HTMLUnknownElement,完全不渲染(肉眼就是"什么都没有")。
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const mkSvg = (name, attrs) => {
    const el = document.createElementNS(SVG_NS, name);
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const hintSvg = mkSvg('svg', { id: 'xq-hint-svg' });
  hintSvg.style.cssText = [
    'position:fixed', 'left:0', 'top:0',
    'width:100vw', 'height:100vh',
    'pointer-events:none', 'z-index:2147483646',
    'overflow:visible', 'display:none',
  ].join(';');
  const defs = mkSvg('defs');
  const marker = mkSvg('marker', {
    id: 'xq-hint-arrow', viewBox: '0 0 10 10', refX: '8', refY: '5',
    markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse',
  });
  marker.appendChild(mkSvg('path', { d: 'M0,0 L10,5 L0,10 Z', fill: '#4ade80' }));
  defs.appendChild(marker);
  hintSvg.appendChild(defs);

  // 自动箭头组 (top1 推荐,轮到我时自动显示)
  const autoGroup = mkSvg('g', { id: 'xq-hint-auto' });
  const hintFromEl = mkSvg('circle', {
    class: 'xq-hint-from', r: '0', fill: 'none',
    stroke: '#4ade80', 'stroke-width': '3', opacity: '0.85',
  });
  const hintLineEl = mkSvg('line', {
    class: 'xq-hint-line', x1: '0', y1: '0', x2: '0', y2: '0',
    stroke: '#4ade80', 'stroke-width': '4', 'stroke-linecap': 'round',
    opacity: '0.9', 'marker-end': 'url(#xq-hint-arrow)',
  });
  const hintToEl = mkSvg('circle', {
    class: 'xq-hint-to', r: '0', fill: '#4ade80', opacity: '0.45',
  });
  autoGroup.appendChild(hintFromEl);
  autoGroup.appendChild(hintLineEl);
  autoGroup.appendChild(hintToEl);
  autoGroup.style.display = 'none';
  hintSvg.appendChild(autoGroup);

  // 点击探索组 — 用户点棋盘某格,把 top3 中从这格出发的走法画成编号圆点
  const clickGroup = mkSvg('g', { id: 'xq-hint-click' });
  hintSvg.appendChild(clickGroup);
  let clickAnchor = null; // 当前聚焦的格子 {fx, fy},方便再点同格关闭

  document.documentElement.appendChild(hintSvg);

  // Board element detection: play.xiangqi.com 的棋盘祖先层级多,挑一个
  // "既包含所有棋子又没带额外 UI" 的容器。按优先级试选择器;失败则扫
  // 棋盘大的子树。结果缓存 2s(布局变化频率远低于此)。
  let cachedBoardEl = null;
  let cachedBoardAt = 0;
  const BOARD_SELECTORS = [
    '.board-wrapper-main',
    '[class*="BoardBorder"]',
    '[class*="board-border"]',
    '[class*="BoardContainer"]',
    '[class*="board-container"]',
  ];
  function findBoardEl() {
    const now = Date.now();
    if (cachedBoardEl && cachedBoardEl.isConnected && now - cachedBoardAt < 2000) {
      return cachedBoardEl;
    }
    for (const sel of BOARD_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.height > 100) {
          cachedBoardEl = el; cachedBoardAt = now;
          return el;
        }
      }
    }
    // Fallback: 选择器都不中 → 全文档扫棋子 DOM,求公共祖先。站点换 UI
    // 框架时,选择器会失效,但"棋子是单字中文"这条语义不大会变。
    const pieceEls = collectPieceEls(document.body || document.documentElement);
    if (pieceEls.length >= 8) {
      const ca = commonAncestor(pieceEls);
      if (ca) {
        const r = ca.getBoundingClientRect();
        if (r.width > 100 && r.height > 100) {
          cachedBoardEl = ca; cachedBoardAt = now;
          xqLog.push('hint-board-fallback', {
            tag: ca.tagName, cls: String(ca.className).slice(0, 60),
            pieceCount: pieceEls.length
          });
          return ca;
        }
      }
    }
    cachedBoardEl = null;
    return null;
  }

  function commonAncestor(nodes) {
    if (nodes.length === 0) return null;
    const paths = nodes.map(n => {
      const p = [];
      let x = n;
      while (x) { p.push(x); x = x.parentElement; }
      return p.reverse();
    });
    const min = Math.min(...paths.map(p => p.length));
    let ca = null;
    for (let i = 0; i < min; i++) {
      const ref = paths[0][i];
      if (paths.every(p => p[i] === ref)) ca = ref;
      else break;
    }
    return ca;
  }

  function collectPieceEls(root) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        let hit = false;
        if (c.children.length === 0) {
          const t = (c.textContent || '').trim();
          if (t.length === 1 && PIECE_CHARS.has(t)) hit = true;
          else if (c.tagName === 'IMG') {
            const a = (c.alt || '').trim();
            if (a.length === 1 && PIECE_CHARS.has(a)) hit = true;
          }
        }
        if (hit) {
          const r = c.getBoundingClientRect();
          if (r.width >= 16 && r.width <= 140 && r.height >= 16) out.push(c);
        } else {
          walk(c);
        }
      }
    };
    walk(root);
    return out;
  }

  // 棋子字符集(红方 + 黑方 + 简/繁体变体)。叶子 DOM 只要 textContent 或
  // <img alt> 是这里头一个字,就算棋子候选。
  const PIECE_CHARS = new Set([
    '帥','仕','相','傌','俥','炮','兵', // 红(繁 + 俥/傌 变体)
    '帅','马','车',                     // 红(简)
    '將','士','象','馬','車','砲','卒', // 黑(繁)
    '将',                               // 黑(简)
  ]);

  // 扫棋盘子树,返回所有看起来像棋子的叶子 DOM 中心点 + 字符。
  function scanPieces(root) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        let piece = null;
        if (c.children.length === 0) {
          const t = (c.textContent || '').trim();
          if (t.length === 1 && PIECE_CHARS.has(t)) piece = t;
          else if (c.tagName === 'IMG') {
            const a = (c.alt || '').trim();
            if (a.length === 1 && PIECE_CHARS.has(a)) piece = a;
          }
        }
        if (piece) {
          const r = c.getBoundingClientRect();
          // 过滤掉过小(图标)或过大(整个棋盘装饰)的。合理棋子 20-120px。
          if (r.width >= 16 && r.width <= 140 && r.height >= 16) {
            out.push({ ch: piece, x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
        } else {
          walk(c);
        }
      }
    };
    walk(root);
    return out;
  }

  // 给定当前 FEN,找出真实占位的 file/rank 极值。棋子少到只剩 4 个时
  // 仍然给出一个范围;更少就放弃校准。
  function fenExtent(fen) {
    const board = fenToBoard(fen);
    let minF = 8, maxF = 0, minR = 9, maxR = 0, count = 0;
    for (let r = 0; r < 10; r++) {
      for (let f = 0; f < 9; f++) {
        if (board[r][f]) {
          count++;
          if (f < minF) minF = f;
          if (f > maxF) maxF = f;
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
        }
      }
    }
    return { minF, maxF, minR, maxR, count };
  }

  // 最近一次算好的网格,按 (board rect 整数取整 + FEN 字段 + 方向) 缓存。
  // 滚动/动画中 rAF 重绘时不重复全树扫描。
  let gridCache = null;
  let gridCacheKey = '';
  function computeBoardGrid(boardEl, fen, preferPlayerSide) {
    const rect = boardEl.getBoundingClientRect();
    const key = [
      Math.round(rect.left), Math.round(rect.top),
      Math.round(rect.width), Math.round(rect.height),
      fen?.split(' ')[0] || '', preferPlayerSide || ''
    ].join('|');
    if (gridCache && gridCacheKey === key) return gridCache;

    const pieces = scanPieces(boardEl);
    const ext = fenExtent(fen);
    if (pieces.length < 4 || ext.count < 4
        || ext.maxF <= ext.minF || ext.maxR <= ext.minR) {
      gridCache = null; gridCacheKey = key;
      return null;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pieces) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const cellW = (maxX - minX) / (ext.maxF - ext.minF);
    const cellH = (maxY - minY) / (ext.maxR - ext.minR);

    // 方向:优先信 playerSide (fiber 读的);读不到就看黑将 (将/將) 在
    // 屏幕上半还是下半。
    let blackBottom;
    if (preferPlayerSide === 'black') blackBottom = true;
    else if (preferPlayerSide === 'red') blackBottom = false;
    else {
      const general = pieces.find(p => p.ch === '将' || p.ch === '將');
      blackBottom = general ? general.y > (minY + maxY) / 2 : false;
    }

    // 屏幕 minX 对应的文件:红下时最左侧 = file ext.minF,黑下时最左侧 =
    // file ext.maxF(因为翻转)。y 同理。
    const x0 = blackBottom
      ? minX - (8 - ext.maxF) * cellW
      : minX - ext.minF * cellW;
    const y0 = blackBottom
      ? minY - ext.minR * cellH
      : minY - (9 - ext.maxR) * cellH;

    gridCache = { x0, y0, cellW, cellH, blackBottom, pieceCount: pieces.length };
    gridCacheKey = key;
    return gridCache;
  }

  // UCI → 屏幕起点/终点中心坐标。网格 cache-hit 时 O(1)。
  function uciEndpointsToScreen(uci, boardEl, playerSide, fen) {
    const p = parseUci(uci);
    if (!p) return null;
    const g = computeBoardGrid(boardEl, fen, playerSide);
    if (!g) return null;
    const toX = (f) => g.blackBottom
      ? g.x0 + (8 - f) * g.cellW
      : g.x0 + f * g.cellW;
    const toY = (r) => g.blackBottom
      ? g.y0 + r * g.cellH
      : g.y0 + (9 - r) * g.cellH;
    return {
      fx: toX(p.fx), fy: toY(p.fy),
      tx: toX(p.tx), ty: toY(p.ty),
      cellSize: Math.min(g.cellW, g.cellH),
    };
  }

  // SVG 容器可见性 = 自动箭头组可见 OR 点击探索组有内容。feature 关掉时
  // 无论如何都隐藏。
  function syncSvgVisible() {
    const autoOn = autoGroup.style.display !== 'none';
    const clickOn = clickGroup.childNodes.length > 0;
    hintSvg.style.display = (showHint && (autoOn || clickOn)) ? '' : 'none';
  }
  function hideHint() {
    autoGroup.style.display = 'none';
    syncSvgVisible();
  }

  // 同一 skip 原因 2 秒内不重复打。每次原因变了立刻再打一条,方便看
  // 状态迁移("等引擎 → 不是我 → 画出来")。
  let lastSkipLog = { why: '', at: 0 };
  function noteSkip(why, extra) {
    xqLog.push('hint-skip', { why, ...(extra || {}) });
    const now = Date.now();
    if (why === lastSkipLog.why && now - lastSkipLog.at < 2000) return;
    lastSkipLog = { why, at: now };
    console.log('[XQ-Hint] skip:', why, extra || '');
  }

  // Canonical: given current state, should the hint be visible and where.
  // Source of truth is `window.__xqValidLines[0].uci` populated by renderAnalysis.
  function renderHint() {
    if (!showHint || !enabled) { noteSkip('disabled', { showHint, enabled }); return hideHint(); }
    if (!currentFen) { noteSkip('no-fen'); return hideHint(); }
    if (!isMyTurn()) { noteSkip('not-my-turn', { turn: currentFen.split(' ')[1], playerSide: currentMeta?.playerSide }); return hideHint(); }
    const lines = window.__xqValidLines;
    if (!Array.isArray(lines) || lines.length === 0) { noteSkip('no-valid-lines'); return hideHint(); }
    const uci = lines[0] && lines[0].uci;
    if (!uci) { noteSkip('no-uci'); return hideHint(); }
    if (analyzingFen && currentFen && analyzingFen !== currentFen) { noteSkip('stale-fen'); return hideHint(); }

    const boardEl = findBoardEl();
    if (!boardEl) { noteSkip('no-board-el'); return hideHint(); }
    const playerSide = currentMeta?.playerSide || null;
    const pts = uciEndpointsToScreen(uci, boardEl, playerSide, currentFen);
    if (!pts) { noteSkip('no-grid', { uci }); return hideHint(); }
    // 第一次成功画出来时打一条,方便知道"通了"
    if (lastSkipLog.why !== 'ok') {
      console.log('[XQ-Hint] render ok:', uci, 'fen:', currentFen.split(' ')[1]);
      lastSkipLog = { why: 'ok', at: Date.now() };
    }

    // Size + radius scale with board cell so the arrow stays proportional
    // across small (phone/mini) and large (fullscreen) boards.
    const r = Math.max(8, pts.cellSize * 0.35);
    hintFromEl.setAttribute('cx', pts.fx);
    hintFromEl.setAttribute('cy', pts.fy);
    hintFromEl.setAttribute('r', r);
    hintToEl.setAttribute('cx', pts.tx);
    hintToEl.setAttribute('cy', pts.ty);
    hintToEl.setAttribute('r', Math.max(5, pts.cellSize * 0.18));
    // Shorten the arrow so the arrowhead sits on the intersection, not
    // overshooting past it.
    const dx = pts.tx - pts.fx, dy = pts.ty - pts.fy;
    const len = Math.hypot(dx, dy) || 1;
    const shrink = Math.min(len * 0.35, r);
    hintLineEl.setAttribute('x1', pts.fx + dx * (shrink / len));
    hintLineEl.setAttribute('y1', pts.fy + dy * (shrink / len));
    hintLineEl.setAttribute('x2', pts.tx - dx * (shrink / len));
    hintLineEl.setAttribute('y2', pts.ty - dy * (shrink / len));
    hintLineEl.setAttribute('stroke-width', Math.max(3, pts.cellSize * 0.09));
    autoGroup.style.display = '';
    syncSvgVisible();
  }

  // ---- 点击探索:点任一格 → 画 top3 中从这格出发的所有走法 ----------
  const CLICK_COLORS = { 1: '#4ade80', 2: '#60a5fa', 3: '#f59e0b' };
  function clearClickMarks() {
    while (clickGroup.firstChild) clickGroup.removeChild(clickGroup.firstChild);
    clickAnchor = null;
    syncSvgVisible();
  }
  function drawClickMarks(fx, fy) {
    while (clickGroup.firstChild) clickGroup.removeChild(clickGroup.firstChild);
    const lines = window.__xqValidLines;
    if (!Array.isArray(lines) || !lines.length) return false;
    const boardEl = findBoardEl();
    if (!boardEl) return false;
    const g = computeBoardGrid(boardEl, currentFen, currentMeta?.playerSide || null);
    if (!g) return false;
    const toX = (f) => g.blackBottom ? g.x0 + (8 - f) * g.cellW : g.x0 + f * g.cellW;
    const toY = (r) => g.blackBottom ? g.y0 + r * g.cellH : g.y0 + (9 - r) * g.cellH;
    const matched = lines
      .map(l => ({ l, p: parseUci(l.uci) }))
      .filter(x => x.p && x.p.fx === fx && x.p.fy === fy);
    if (matched.length === 0) return false;

    // "起点" ring on the clicked square
    const rFrom = Math.max(10, g.cellW * 0.33);
    const fromRing = mkSvg('circle', {
      cx: toX(fx), cy: toY(fy), r: rFrom,
      fill: 'none', stroke: '#ffffff',
      'stroke-width': '3', opacity: '0.9',
    });
    fromRing.setAttribute('stroke-dasharray', '6 4');
    clickGroup.appendChild(fromRing);

    // 每条推荐一个终点圆 + 中心数字
    const rDot = Math.max(12, g.cellW * 0.32);
    for (const { l, p } of matched) {
      const color = CLICK_COLORS[l.multipv] || '#c6ccd8';
      const cx = toX(p.tx), cy = toY(p.ty);
      const dot = mkSvg('circle', {
        cx, cy, r: rDot, fill: color, opacity: '0.82',
        stroke: '#ffffff', 'stroke-width': '2.5',
      });
      clickGroup.appendChild(dot);
      const txt = mkSvg('text', {
        x: cx, y: cy + rDot * 0.35,
        'text-anchor': 'middle',
        'font-size': rDot * 1.0,
        'font-weight': '800',
        'font-family': 'system-ui,-apple-system,sans-serif',
        fill: '#ffffff',
      });
      txt.textContent = String(l.multipv);
      clickGroup.appendChild(txt);
    }
    clickAnchor = { fx, fy };
    syncSvgVisible();
    return true;
  }

  // 屏幕坐标 → 最近的棋盘格 (fx, fy)。距离超 0.55 个 cell 就认为点空了。
  function screenToSquare(x, y) {
    const boardEl = findBoardEl();
    if (!boardEl) return null;
    const g = computeBoardGrid(boardEl, currentFen, currentMeta?.playerSide || null);
    if (!g) return null;
    const rawF = (x - g.x0) / g.cellW;
    const rawR = (y - g.y0) / g.cellH;
    const fShown = Math.round(rawF);
    const rShown = Math.round(rawR);
    if (Math.abs(rawF - fShown) > 0.55) return null;
    if (Math.abs(rawR - rShown) > 0.55) return null;
    if (fShown < 0 || fShown > 8 || rShown < 0 || rShown > 9) return null;
    const fx = g.blackBottom ? 8 - fShown : fShown;
    const fy = g.blackBottom ? rShown : 9 - rShown;
    return { fx, fy };
  }

  // 全局点击监听(capture 但不 preventDefault —— 站点自己的选子逻辑照常跑)
  document.addEventListener('click', (ev) => {
    if (!showHint) return;
    const boardEl = findBoardEl();
    if (!boardEl) return;
    const rect = boardEl.getBoundingClientRect();
    // 点在棋盘矩形外 → 认为是"取消探索",清掉点击图层
    if (ev.clientX < rect.left || ev.clientX > rect.right
     || ev.clientY < rect.top || ev.clientY > rect.bottom) {
      if (clickAnchor) clearClickMarks();
      return;
    }
    const sq = screenToSquare(ev.clientX, ev.clientY);
    if (!sq) return;
    // 再点同一格 → 关掉
    if (clickAnchor && clickAnchor.fx === sq.fx && clickAnchor.fy === sq.fy) {
      clearClickMarks();
      return;
    }
    const ok = drawClickMarks(sq.fx, sq.fy);
    xqLog.push('hint-click', { fx: sq.fx, fy: sq.fy, matched: ok });
  }, true);

  // Keep the arrow glued to the board on scroll / resize / layout jitter.
  // rAF tick while visible absorbs animated container moves we don't get
  // events for (e.g. site-side transitions).
  let hintRafPending = false;
  function scheduleHintRepaint() {
    if (hintRafPending) return;
    hintRafPending = true;
    requestAnimationFrame(() => { hintRafPending = false; renderHint(); });
  }
  window.addEventListener('resize', scheduleHintRepaint, { passive: true });
  window.addEventListener('scroll', scheduleHintRepaint, { passive: true, capture: true });

  function applyHintButton() {
    if (!hintBtn) return;
    hintBtn.classList.toggle('xq-hint-on', showHint);
    hintBtn.textContent = showHint ? '➤' : '✖';
    hintBtn.title = showHint
      ? '落子提示已开(点击关闭) · 箭头偏了运行 __xqHintDebug() 查网格'
      : '落子提示已关(点击开启)';
  }
  applyHintButton();
  if (hintBtn) {
    hintBtn.addEventListener('click', () => {
      showHint = !showHint;
      try { localStorage.setItem(HINT_KEY, showHint ? '1' : '0'); } catch (_) {}
      applyHintButton();
      renderHint();
      xqLog.push('hint-toggle', { on: showHint });
    });
  }

  // Console 排错:如果箭头画偏了,跑这个看扫出来的棋子 + 网格推断。
  // 偏差一般来自 (1) 棋子扫描漏了角/选到了非棋子元素 (2) 方向反了。
  window.__xqHintDebug = function () {
    const boardEl = findBoardEl();
    if (!boardEl) { console.log('[XQ-Hint] 没找到棋盘元素'); return null; }
    const pieces = scanPieces(boardEl);
    const ext = fenExtent(currentFen || '');
    const playerSide = currentMeta?.playerSide || null;
    const g = computeBoardGrid(boardEl, currentFen, playerSide);
    console.group('[XQ-Hint] debug');
    console.log('boardEl:', boardEl);
    console.log('pieces scanned:', pieces.length);
    console.table(pieces.slice(0, 16).map(p => ({
      ch: p.ch, x: Math.round(p.x), y: Math.round(p.y)
    })));
    console.log('FEN extent:', ext);
    console.log('inferred grid:', g);
    console.log('playerSide (fiber):', playerSide);
    console.groupEnd();
    return { pieces, ext, grid: g, playerSide };
  };

  // MAIN world 的 Console 不能直接调 ISOLATED 的 __xqHintDebug —— 很多用户
  // 不知道 Console 上下文切换怎么操作。用 DOM 事件做桥:MAIN 里 dispatch
  // 'xq-debug',ISO 这里监听,把结果 console.log 出来(ISO 的 console 和
  // 页面共用同一个 DevTools 面板,输出在同一个地方看得到)。
  document.addEventListener('xq-debug', (ev) => {
    const k = ev.detail && ev.detail.kind;
    if (!k || k === 'hint') window.__xqHintDebug();
    if (!k || k === 'skip') {
      console.log('[XQ-Hint] hint-skip last 5:', xqLog.dump('hint-skip').slice(-5));
    }
    if (!k || k === 'lines') {
      console.log('[XQ-Hint] __xqValidLines:', window.__xqValidLines);
    }
    if (!k || k === 'state') {
      console.log('[XQ-Hint] state:', {
        showHint, enabled, currentFen, currentMeta,
        isMyTurn: typeof isMyTurn === 'function' ? isMyTurn() : null,
        analyzingFen,
      });
    }
  });

  // ---- 自评:我下的棋和引擎推荐的重合度 -----------------------------------
  // 缓存"轮到我时引擎吐的 top3"→ 下一次 FEN 切到对方,拿 lastMove 查表。
  // 命中 #1 → 绿 ✓;#2/#3 → 黄 △;都没中 → 红 ✗;引擎来不及出 → 灰 —
  //
  // 统计按 gameId 隔离,换一局自动清零,避免本局表现被历史数据冲淡。
  // 用户点 chip 可以手动清零当前局。存 localStorage,刷新浏览器不丢。
  let moveStats = { gameId: null, total: 0, top1: 0, top3: 0 };
  try {
    const s = localStorage.getItem(MATCH_KEY);
    if (s) {
      const v = JSON.parse(s);
      if (v && typeof v === 'object') moveStats = { ...moveStats, ...v };
    }
  } catch (_) {}
  // { fen, list: [{uci, multipv}] } — 下一步落子时对账用
  let lastMySuggestions = null;

  const matchStatEl = $('xq-matchstat');
  const flashEl = $('xq-flash');
  function renderMoveStats() {
    if (!matchStatEl) return;
    const { total, top1, top3 } = moveStats;
    matchStatEl.classList.remove('xq-matchstat-good', 'xq-matchstat-weak', 'xq-matchstat-mid');
    if (total === 0) {
      matchStatEl.textContent = '重合 —';
      matchStatEl.title = '我的走子和引擎首选重合度(本局) · 尚无数据 · 点击清零';
      return;
    }
    const pct1 = Math.round((top1 / total) * 100);
    const pct3 = Math.round((top3 / total) * 100);
    matchStatEl.textContent = `重合 ${top1}/${total} · ${pct1}%`;
    matchStatEl.title =
      `首选命中 ${top1}/${total} (${pct1}%)\n` +
      `前三命中 ${top3}/${total} (${pct3}%)\n` +
      `点击清零`;
    if (pct1 >= 65) matchStatEl.classList.add('xq-matchstat-good');
    else if (pct1 < 35) matchStatEl.classList.add('xq-matchstat-weak');
    else matchStatEl.classList.add('xq-matchstat-mid');
  }
  renderMoveStats();
  if (matchStatEl) {
    matchStatEl.addEventListener('click', () => {
      const gid = currentMeta?.gameId || moveStats.gameId || null;
      moveStats = { gameId: gid, total: 0, top1: 0, top3: 0 };
      try { localStorage.setItem(MATCH_KEY, JSON.stringify(moveStats)); } catch (_) {}
      renderMoveStats();
      xqLog.push('match-stats-reset', { gameId: gid });
    });
  }

  // 闪烁反馈 — 1.6s 动画,下一回合来临前一般已经淡出
  function flashMoveFeedback(rank, moveUci, topSuggestion) {
    if (!flashEl) return;
    let text, cls, sub;
    if (rank === 1)        { cls = 'xq-flash-top1'; text = '✓'; sub = '最佳着法'; }
    else if (rank === 2)   { cls = 'xq-flash-near'; text = '△'; sub = '第二选择'; }
    else if (rank === 3)   { cls = 'xq-flash-near'; text = '△'; sub = '第三选择'; }
    else if (rank === 0)   { cls = 'xq-flash-miss'; text = '✗';
                             sub = topSuggestion ? `引擎首选 ${topSuggestion}` : '未进前三'; }
    else                   { cls = 'xq-flash-na';   text = '—'; sub = '引擎未出结果'; }
    flashEl.className = 'xq-flash';
    flashEl.innerHTML = `
      <span class="xq-flash-mark">${text}</span>
      <span class="xq-flash-sub">${escapeHtml(sub)}</span>
    `;
    // Force reflow so restart of the animation actually plays when rapid-fire
    void flashEl.offsetWidth;
    flashEl.classList.add(cls, 'xq-flash-show');
    clearTimeout(flashEl._t);
    flashEl._t = setTimeout(() => flashEl.classList.remove('xq-flash-show'), 1700);
  }

  // 监测"刚走了一步"的 FEN 迁移,对账然后更新统计 + 闪一下反馈。
  // prev* 都是迁移前的值,必须在 currentMeta 被覆写前捕获。
  function observeMyMove({ prevFen, prevTurn, prevLastMove, detail }) {
    const mySide = effectivePersp();
    const newTurn = detail.turn === 'r' ? 'red' : detail.turn === 'b' ? 'black' : detail.turn;
    // 我刚走了 = 上一帧该我走,现在该对方 + 站点报了一个新的 lastMove
    const iJustMoved =
      prevTurn === mySide &&
      newTurn && newTurn !== mySide &&
      detail.lastMove && detail.lastMove !== prevLastMove;
    if (!iJustMoved) return;

    // 换局 → 清零统计。lastMySuggestions 也作废,不能把上一局引擎建议
    // 算到这一局的第一步上。
    const gameId = detail.gameId || null;
    if (gameId && moveStats.gameId !== gameId) {
      moveStats = { gameId, total: 0, top1: 0, top3: 0 };
      lastMySuggestions = null;
    }

    let rank = -1; // -1 = 没有可对账的建议;0 = 引擎出了但没中;1/2/3 = 命中
    let topUci = null;
    if (lastMySuggestions && lastMySuggestions.fen === prevFen
        && Array.isArray(lastMySuggestions.list) && lastMySuggestions.list.length) {
      topUci = lastMySuggestions.list[0].uci || null;
      const hit = lastMySuggestions.list.find(x => x.uci === detail.lastMove);
      rank = hit ? (hit.multipv || 0) : 0;
      moveStats.total++;
      if (rank === 1) { moveStats.top1++; moveStats.top3++; }
      else if (rank === 2 || rank === 3) { moveStats.top3++; }
      try { localStorage.setItem(MATCH_KEY, JSON.stringify(moveStats)); } catch (_) {}
    }

    xqLog.push('my-move-match', {
      trace: currentTrace,
      move: detail.lastMove,
      rank,
      top: topUci,
      hadSuggestion: !!lastMySuggestions,
      suggestionFenMatched: lastMySuggestions?.fen === prevFen,
      stats: { ...moveStats }
    });

    flashMoveFeedback(rank, detail.lastMove, topUci);
    renderMoveStats();
    // 防止下一步被重复判:建议列表已"用过了"
    lastMySuggestions = null;
  }

  function applyPerspectiveUi() {
    if (perspective === 'auto') {
      const eff = effectivePersp();
      perspBtn.textContent = eff === 'red' ? '自动·红' : '自动·黑';
    } else {
      perspBtn.textContent = perspective === 'red' ? '红' : '黑';
    }
    const eff = effectivePersp();
    perspBtn.classList.toggle('xq-persp-red', eff === 'red');
    perspBtn.classList.toggle('xq-persp-black', eff === 'black');
    perspBtn.classList.toggle('xq-persp-auto', perspective === 'auto');
    updateTurnBadges();
  }

  // "谁走棋 / 评分哪方视角" 两个标签同步。视角锚定 effectivePersp(),
  // 走棋锚定 currentTurn。两者可同可异:
  //   你是黑、轮到你走 → 黑视角 + 黑方走棋 (同步,正常)
  //   你是黑、轮到对方 → 黑视角 + 红方走棋 (此时 stop, UI 仍要显示)
  function updateTurnBadges() {
    const eff = effectivePersp();
    // 视角是否带到 meta 胶囊上 - 由 renderAnalysis 每次写 meta 时顺带更新,
    // 这里只管标红/黑两档颜色(即使还没引擎结果,切视角时颜色也跟着变)
    if (metaEl) {
      metaEl.classList.toggle('xq-meta-red', eff === 'red');
      metaEl.classList.toggle('xq-meta-black', eff === 'black');
    }
    if (moverEl && moverTextEl) {
      if (!currentFen) {
        moverTextEl.textContent = '等待局面…';
        moverEl.classList.remove('xq-mover-red', 'xq-mover-black', 'xq-mover-mine');
      } else {
        const t = currentTurn || 'red';
        moverTextEl.textContent = t === 'red' ? '红方走棋' : '黑方走棋';
        moverEl.classList.toggle('xq-mover-red', t === 'red');
        moverEl.classList.toggle('xq-mover-black', t === 'black');
        moverEl.classList.toggle('xq-mover-mine', t === eff);
      }
    }
  }
  applyPerspectiveUi();
  perspBtn.addEventListener('click', () => {
    // Cycle: auto → red → black → auto
    const from = perspective;
    perspective =
      perspective === 'auto' ? 'red' :
      perspective === 'red'  ? 'black' : 'auto';
    xqLog.push('persp', { from, to: perspective, effective: effectivePersp() });
    try { localStorage.setItem(PERSP_KEY, perspective); } catch (_) {}
    applyPerspectiveUi();
    // Re-render if we have the latest analysis cached — otherwise wait for next tick
    if (lastAnalysisMsg) renderAnalysis(lastAnalysisMsg, lastAnalysisFinal);
    else renderHint();
    // Perspective flip may swap whose turn it is → re-decide analyze/hold
    if (enabled && currentFen) {
      if (isMyTurn()) requestAnalyze(currentFen);
      else { stopAnalyze(); setStatus('等对方走', 'waiting'); }
    }
  });

  // Cache the most recent analysis so perspective switch can re-render instantly
  let lastAnalysisMsg = null;
  let lastAnalysisFinal = false;

  toggleBtn.addEventListener('click', () => {
    enabled = !enabled;
    toggleBtn.textContent = enabled ? '⏸' : '▶';
    if (!enabled) {
      stopAnalyze();
      setStatus('已暂停', 'paused');
      return;
    }
    if (currentFen && isMyTurn()) {
      requestAnalyze(currentFen);
    } else if (currentFen) {
      setStatus('等对方走', 'waiting');
    } else {
      setStatus(engineReady ? '就绪' : '引擎加载中…', engineReady ? 'idle' : 'loading');
    }
  });

  let collapsed = false;
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    root.classList.toggle('xq-collapsed', collapsed);
    collapseBtn.textContent = collapsed ? '+' : '─';
  });

  // -- Drag (header) ------------------------------------------------------
  (function makeDraggable() {
    const header = root.querySelector('.xq-header');
    let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const r = root.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      origLeft = r.left; origTop = r.top;
      root.style.right = 'auto';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      root.style.left = (origLeft + e.clientX - startX) + 'px';
      root.style.top  = (origTop  + e.clientY - startY) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  })();

  // -- Messaging ----------------------------------------------------------
  // status 现在两段:dot(状态色) + text。kind 决定 dot 颜色和动画。
  // kind ∈ {idle, loading, thinking, done, error, paused, waiting}
  const STATUS_KINDS = ['idle', 'loading', 'thinking', 'done', 'error', 'paused', 'waiting'];
  const statusTextEl = statusEl.querySelector('.xq-status-text');
  function setStatus(s, kind) {
    if (statusTextEl) statusTextEl.textContent = s;
    else statusEl.textContent = s;
    if (kind) {
      for (const k of STATUS_KINDS) statusEl.classList.toggle(`xq-status-${k}`, k === kind);
    }
  }

  // 进度条 — 引擎加载/切换时显示。两种模式:
  //   indeterminate (滑块来回扫): 不知道总大小时
  //   determinate (按百分比填充): 收到 nnueProgress 后切换
  const engineProgressEl = $('xq-engine-progress');
  const engineProgressBarEl = engineProgressEl?.querySelector('.xq-engine-progress-bar');
  function showEngineProgress(on) {
    if (!engineProgressEl) return;
    engineProgressEl.classList.toggle('xq-engine-progress-on', !!on);
    if (!on) {
      engineProgressEl.classList.remove('xq-engine-progress-determinate');
      if (engineProgressBarEl) engineProgressBarEl.style.width = '';
    }
  }
  function setEngineProgressPct(pct) {
    if (!engineProgressEl || !engineProgressBarEl) return;
    engineProgressEl.classList.add('xq-engine-progress-on', 'xq-engine-progress-determinate');
    engineProgressBarEl.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  document.addEventListener('xq:fen', (ev) => {
    const detail = ev.detail || {};
    const { fen, turn } = detail;
    if (!fen) return;
    // 捕获迁移前快照 — 在 currentFen/currentTurn/currentMeta 被覆写前读,
    // 不然 observeMyMove 里拿到的"上一步"永远等于"这一步"。
    const prevFen = currentFen;
    const prevTurn = currentTurn;
    const prevLastMove = currentMeta?.lastMove || null;
    currentFen = fen;
    currentTurn = turn || 'red';
    currentTrace = xqLog.newTrace();
    xqLog.push('fen', {
      trace: currentTrace,
      mc: detail.moveCount,
      turn: currentTurn,
      playerSide: detail.playerSide,
      lastMove: detail.lastMove,
      fen
    });
    const prevPlayerSide = currentMeta?.playerSide;
    currentMeta = detail;
    updateTurnBadges();
    // 对账:我走了没?命中 top3 没?要在 currentMeta 更新之后(这样
    // effectivePersp() 跟着新的 playerSide 走),但在 renderAnalysis 被
    // stale 清零前。
    observeMyMove({ prevFen, prevTurn, prevLastMove, detail });
    // Debug bar: show moveCount + board-only part of FEN (first field)
    if (fenEl) {
      const boardPart = fen.split(' ')[0];
      fenEl.textContent = `#${detail.moveCount ?? '?'} ${boardPart}`;
      fenEl.classList.remove('xq-fen-bad');
      fenEl.title = '当前喂给引擎的 FEN · 点击复制';
    }
    // If the detected player side just resolved (or flipped, rare), refresh
    // the button label so `自动·红/黑` stays accurate.
    if (detail.playerSide !== prevPlayerSide) applyPerspectiveUi();
    // Record position on every FEN change (no eval yet)
    recordPosition(detail, null);
    if (!enabled) return;
    if (!isMyTurn()) {
      // Opponent's move — keep last analysis visible, stop any in-flight job
      stopAnalyze();
      setStatus('等对方走', 'waiting');
      return;
    }
    requestAnalyze(fen);
  });

  // 非法 FEN 被 content-main 拦下时,显式把拒绝信息贴在 debug bar 上,
  // 这样一眼就能看到"哪几次读 FEN 失败、失败原因"。不覆盖 currentFen —
  // 分析层面仍然沿用上一个合法 FEN,不会污染引擎输入。
  document.addEventListener('xq:fen-reject', (ev) => {
    const { rawFen, why, consecutiveBad } = ev.detail || {};
    xqLog.push('fen-reject', { rawFen, why, consecutiveBad });
    if (!fenEl) return;
    const head = (rawFen || '').split(' ')[0].slice(0, 40);
    fenEl.textContent = `⚠ reject×${consecutiveBad} ${why} · ${head}`;
    fenEl.classList.add('xq-fen-bad');
    fenEl.title = `被拒 FEN (连续第 ${consecutiveBad} 次)\n原因: ${why}\n原始: ${rawFen}`;
  });

  function recordPosition(meta, evalData) {
    if (!ctxAlive()) return;
    if (!meta || !meta.gameId) return;
    try {
      chrome.runtime.sendMessage({
        to: 'background',
        type: 'recordPosition',
        data: {
          gameId: meta.gameId,
          moveCount: meta.moveCount,
          fen: meta.fen,
          turn: meta.turn,
          lastMove: meta.lastMove,
          moveIndex: meta.moveIndex,
          players: meta.players,
          state: meta.state,
          winner: meta.winner,
          result: meta.result,
          endReason: meta.endReason,
          eval: evalData
        }
      }).catch(() => {});
    } catch (_) {}
  }

  // Detects "extension context invalidated" — happens when the extension is
  // reloaded while the page is still open. Old content scripts lose their
  // chrome.runtime binding.
  function ctxAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (_) { return false; }
  }

  function showContextLost() {
    setStatus('请刷新页面', 'error');
    linesEl.innerHTML =
      '<li class="xq-empty">扩展已重载,请刷新本页面 (F5)</li>';
  }

  // 友好名:loading "pikafish" 比 "pikafish-id-string" 体面些
  function engineDisplayName(id) {
    const e = availableEngines.find(x => x.id === id);
    return e?.name || id || '—';
  }

  function requestAnalyze(fen) {
    if (!ctxAlive()) { showContextLost(); return; }
    // Throttle: don't dispatch more than once per 200ms
    const now = Date.now();
    const wait = Math.max(0, 200 - (now - lastDispatchAt));
    if (pendingDispatch) clearTimeout(pendingDispatch);
    pendingDispatch = setTimeout(() => {
      pendingDispatch = null;
      lastDispatchAt = Date.now();
      if (!ctxAlive()) { showContextLost(); return; }
      setStatus(engineReady ? '分析中…' : '引擎加载中…', engineReady ? 'thinking' : 'loading');
      // Reset display while we wait for first info. Show what's actually
      // happening — if engine isn't ready yet, the wait isn't analysis but
      // the WASM/NNUE cold start (Pikafish first run can take 5-10s).
      linesEl.innerHTML = engineReady
        ? '<li class="xq-empty">分析中…</li>'
        : `<li class="xq-empty">${escapeHtml(engineDisplayName(selectedEngineId))} 加载中…</li>`;
      clearVerdict(engineReady ? '分析中…' : '引擎加载中…');
      analyzingFen = fen;
      analyzingTurn = currentTurn;
      xqLog.push('engine-dispatch', {
        trace: currentTrace,
        turn: currentTurn,
        engineId: selectedEngineId,
        moveTime: selectedMoveTime,
        fen
      });
      console.log(
        `[XQ-Overlay] → engine=${selectedEngineId || 'default'} mt=${selectedMoveTime} mc=${currentMeta?.moveCount} turn=${currentTurn}\n  ${fen}`
      );
      try {
        chrome.runtime.sendMessage({
          to: 'background',
          type: 'analyze',
          fen,
          engineId: selectedEngineId,
          moveTime: selectedMoveTime
        }).catch(err => {
          if (String(err).includes('Extension context invalidated')) showContextLost();
          else console.warn('[XQ-Overlay] dispatch failed', err);
        });
      } catch (err) {
        showContextLost();
      }
    }, wait);
  }

  function stopAnalyze() {
    analyzingFen = null;
    analyzingTurn = null;
    // 对手走棋 / 暂停 / 切换 → 收起箭头,不让过时建议继续挂在棋盘上
    hideHint();
    if (!ctxAlive()) return;
    try {
      chrome.runtime.sendMessage({ to: 'background', type: 'stop' }).catch(() => {});
    } catch (_) {}
  }

  if (!ctxAlive()) { showContextLost(); return; }
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.to !== 'content') return;
    switch (msg.type) {
      case 'engineList':
        availableEngines = msg.engines || [];
        if (!selectedEngineId || !availableEngines.find(e => e.id === selectedEngineId)) {
          selectedEngineId = msg.defaultId || availableEngines[0]?.id || null;
        }
        renderEngineDropdown();
        xqLog.push('engine-list', { count: availableEngines.length, selected: selectedEngineId });
        // Tell offscreen which engine to warm up. Without this, offscreen
        // would idle and only start loading when the first FEN dispatches
        // — for Pikafish that's a 51MB NNUE download blocking analysis.
        // 挂载阶段若 selectedEngineId 已知,早已发过一次 preload——这里
        // 只在引擎 id 跟那次不同(比如注册表里没有保存的那个 id,回退到
        // defaultId)时再补发。
        if (selectedEngineId && ctxAlive() && selectedEngineId !== preloadedEngineId) {
          xqLog.push('engine-preload', { engineId: selectedEngineId, early: false });
          try {
            chrome.runtime.sendMessage({
              to: 'background',
              type: 'preload',
              engineId: selectedEngineId
            }).catch(() => {});
            preloadedEngineId = selectedEngineId;
          } catch (_) {}
        }
        break;
      case 'engineLoading':
        engineReady = false;
        xqLog.push('engine-loading', { engineId: msg.engineId });
        setStatus(`${engineDisplayName(msg.engineId)} 加载中…`, 'loading');
        showEngineProgress(true);
        // Replace the lines area too so the user knows the wait is engine,
        // not "engine done analyzing nothing". Real % shows up when
        // nnueProgress messages arrive.
        linesEl.innerHTML = `<li class="xq-empty">${escapeHtml(engineDisplayName(msg.engineId))} 加载中…</li>`;
        break;
      case 'nnueProgress': {
        const { engineId, loaded, total } = msg;
        const mb = (loaded / 1048576).toFixed(1);
        if (total > 0) {
          const pct = Math.floor((loaded / total) * 100);
          setEngineProgressPct(pct);
          const tot = (total / 1048576).toFixed(0);
          setStatus(`权重下载 ${pct}% · ${mb}/${tot}MB`, 'loading');
          linesEl.innerHTML = `<li class="xq-empty">${escapeHtml(engineDisplayName(engineId))} 权重下载中 · ${mb}/${tot}MB</li>`;
          // Throttle log to 10% buckets (and the final 100%). Offscreen sends
          // ~16 events/sec; logging each one would drown the trace buffer.
          if (lastNnueLogEngine !== engineId) {
            lastNnueLogEngine = engineId;
            lastNnueLogBucket = -1;
          }
          const bucket = pct === 100 ? 100 : Math.floor(pct / 10) * 10;
          if (bucket > lastNnueLogBucket) {
            lastNnueLogBucket = bucket;
            xqLog.push('nnue-progress', { engineId, pct, mb: +mb, total });
          }
        } else {
          // No Content-Length header — at least surface bytes received.
          setStatus(`权重下载 ${mb}MB…`, 'loading');
          linesEl.innerHTML = `<li class="xq-empty">${escapeHtml(engineDisplayName(engineId))} 权重下载中 · ${mb}MB</li>`;
        }
        break;
      }
      case 'engineReady':
        engineReady = true;
        xqLog.push('engine-ready', { engineId: msg.engineId });
        showEngineProgress(false);
        // If a different engine just became active (auto-init or switch reply),
        // sync the dropdown so UI reflects reality.
        if (msg.engineId && msg.engineId !== selectedEngineId
            && availableEngines.find(e => e.id === msg.engineId)
            && !localStorage.getItem(ENGINE_KEY)) {
          selectedEngineId = msg.engineId;
          if (engineSel) engineSel.value = msg.engineId;
          updateEngineDesc();
        }
        setStatus(enabled ? '就绪' : '已暂停', enabled ? 'idle' : 'paused');
        // Kick off analysis only if we're not already running on the current
        // FEN. Otherwise an engineReady mid-analysis (e.g. after a switch
        // where offscreen already started analyzing) re-dispatches and forces
        // a stop/restart — visible as a UI flicker.
        if (enabled && currentFen) {
          if (isMyTurn() && analyzingFen !== currentFen) requestAnalyze(currentFen);
          else if (!isMyTurn()) setStatus('等对方走', 'waiting');
        } else if (!currentFen) {
          // Ask MAIN world to re-poll
          document.dispatchEvent(new CustomEvent('xq:request-fen'));
        }
        break;
      case 'engineLog':
        xqLog.push('engine-io', { line: msg.line || '' });
        break;
      case 'engineError':
        xqLog.push('engine-error', { message: msg.message || '' });
        setStatus('引擎出错', 'error');
        showEngineProgress(false);
        linesEl.innerHTML = `<li class="xq-empty">引擎出错: ${escapeHtml(msg.message || '')}</li>`;
        break;
      case 'analysisProgress':
        // Engine is actively returning depth → keep status pinned to
        // thinking. No-op on subsequent calls since the kind is the same.
        if (!statusEl.classList.contains('xq-status-thinking')) {
          setStatus('分析中…', 'thinking');
        }
        renderAnalysis(msg, /*final*/ false);
        break;
      case 'analysisDone':
        renderAnalysis(msg, /*final*/ true);
        setStatus('分析完成', 'done');
        // Update the stored position with final eval (top line)
        if (currentMeta) {
          const top = (msg.lines || []).slice().sort((a,b)=>a.multipv-b.multipv)[0];
          if (top) {
            recordPosition(currentMeta, {
              cp: top.cp ?? null,
              mate: top.mate ?? null,
              depth: msg.depth ?? top.depth ?? null,
              bestPv: (top.pv || []).slice(0, 6)
            });
          }
        }
        break;
    }
  });

  // -- UCI → 白话着法 ------------------------------------------------------
  const PIECE_NAME = {
    'K': '帥', 'A': '仕', 'B': '相', 'N': '馬', 'R': '車', 'C': '炮', 'P': '兵',
    'k': '将', 'a': '士', 'b': '象', 'n': '马', 'r': '车', 'c': '砲', 'p': '卒'
  };

  // UCI regex: file(a-i) + rank(1-10) + file + rank(1-10)
  const UCI_RE = /^([a-i])(\d{1,2})([a-i])(\d{1,2})$/;
  // Internally 0-indexed: rank 0 = red back rank, rank 9 = black back rank.
  // FEN's first row = internal rank 9; UCI's rank N = internal N-1.

  function parseUci(uci) {
    if (!uci) return null;
    const m = uci.match(UCI_RE);
    if (!m) return null;
    const fx = m[1].charCodeAt(0) - 97;
    const fy = parseInt(m[2], 10) - 1;
    const tx = m[3].charCodeAt(0) - 97;
    const ty = parseInt(m[4], 10) - 1;
    if (fy < 0 || fy > 9 || ty < 0 || ty > 9) return null;
    return { fx, fy, tx, ty };
  }

  function fenToBoard(fen) {
    const board = Array.from({ length: 10 }, () => Array(9).fill(null));
    if (!fen) return board;
    const rows = fen.split(' ')[0].split('/');
    for (let i = 0; i < rows.length; i++) {
      const rank = 9 - i;
      let file = 0;
      for (const ch of rows[i]) {
        if (ch >= '1' && ch <= '9') file += parseInt(ch, 10);
        else { if (rank >= 0 && rank <= 9 && file <= 8) board[rank][file] = ch; file++; }
      }
    }
    return board;
  }

  function applyUci(board, uci) {
    const p = parseUci(uci);
    const nb = board.map(r => r.slice());
    if (!p) return nb;
    const piece = nb[p.fy][p.fx];
    nb[p.fy][p.fx] = null;
    nb[p.ty][p.tx] = piece;
    return nb;
  }

  // Work out a disambiguation prefix (前/后/左/中/右/N路) when the side has
  // more than one piece of this exact letter on the board. Pawns are the
  // tricky case — up to 5 per side — so we extend the standard scheme.
  function disambiguate(board, piece, fx, fy, isRed) {
    const same = [];
    for (let r = 0; r < 10; r++) {
      for (let f = 0; f < 9; f++) {
        if (board[r][f] === piece) same.push({ f, r });
      }
    }
    if (same.length <= 1) return '';

    // (a) Multiple on my file → 前 / 二 / 三 / 四 / 后 (前 = closer to enemy)
    const onFile = same.filter(s => s.f === fx);
    if (onFile.length >= 2) {
      onFile.sort((a, b) => isRed ? b.r - a.r : a.r - b.r);
      const idx = onFile.findIndex(s => s.r === fy);
      const n = onFile.length;
      if (n === 2) return idx === 0 ? '前' : '后';
      if (n === 3) return ['前', '中', '后'][idx];
      // 4 or 5: 前 / 二 / 三 / 四 / 后
      if (idx === 0) return '前';
      if (idx === n - 1) return '后';
      return ['', '', '二', '三', '四'][idx + 1] || '中';
    }

    // (b) I'm solo on my file → label among all same-piece pawns by file.
    //     2-3 total: 左/中/右. 4-5 total: fall back to player-side file number
    //     (红方从右到左 1-9;黑方从右到左 1-9 — 即本方视角).
    const byFile = same.slice().sort((a, b) => isRed ? a.f - b.f : b.f - a.f);
    const idx = byFile.findIndex(s => s.f === fx && s.r === fy);
    const n = same.length;
    if (n === 2) return idx === 0 ? '左' : '右';
    if (n === 3) return ['左', '中', '右'][idx];
    // 4 or 5 across files — "N路" uniquely identifies each pawn.
    // Red: rightmost file = 1路 (fx=8); leftmost = 9路 (fx=0).
    // Black (flipped view): their right = fx=0 = 1路; fx=8 = 9路.
    const fileNum = isRed ? (9 - fx) : (fx + 1);
    return fileNum + '路';
  }

  function uciToPlain(uci, board) {
    const p = parseUci(uci);
    if (!p) return '??';
    const piece = board[p.fy] && board[p.fy][p.fx];
    if (!piece) return '??';
    const name = PIECE_NAME[piece] || piece;
    const isRed = piece === piece.toUpperCase();
    const prefix = disambiguate(board, piece, p.fx, p.fy, isRed);
    const label = prefix + name;
    const dx = p.tx - p.fx, dy = p.ty - p.fy;
    // Player-relative: forward = toward enemy, right = piece's own right hand
    const forward = isRed ? dy : -dy;
    const right = isRed ? dx : -dx;
    const vert = forward > 0 ? '前' : '后';
    const horz = right > 0 ? '右' : '左';
    const type = piece.toUpperCase();

    if (type === 'N') {
      // 马是 L 型,同一个"左前/右前/左后/右后"有两种走法:
      //   大跳: 横 2 竖 1 (|dx|==2)
      //   小跳: 横 1 竖 2 (|dx|==1)
      const scale = Math.abs(dx) === 2 ? '大' : '小';
      return `${label}${horz}${vert}${scale}跳`;
    }
    if (type === 'B') return `${label}${horz}${vert}飞`; // 象必为 (±2,±2),方向唯一
    if (type === 'A') return `${label}${horz}${vert}`;   // 士必为 (±1,±1),方向唯一
    // R / C / K / P: straight / sliding pieces
    if (dx === 0) return `${label}${forward > 0 ? '前进' : '后退'}${Math.abs(forward)}`;
    if (dy === 0) return `${label}${right > 0 ? '右平' : '左平'}${Math.abs(right)}`;
    // Diagonal fallback — never hit by legal xiangqi moves, but stay Chinese.
    return `${label}${horz}${vert}`;
  }

  function pvToPlain(pv, startFen) {
    if (!Array.isArray(pv) || pv.length === 0) return '';
    let board = fenToBoard(startFen);
    const out = [];
    for (const m of pv) {
      if (!m || m.length < 4) break;
      out.push(uciToPlain(m, board));
      board = applyUci(board, m);
    }
    return out.join('  ');
  }

  // Render PV as a run of <span> plies alternating own/opp classes, so the
  // user can tell at a glance which moves are their own and which are the
  // predicted opponent reply. `startTurn` is the side-to-move at the start
  // of the PV ('red'|'black'). `mySide` is what counts as "own".
  function pvToPlainHtml(pv, startFen, startTurn, mySide) {
    if (!Array.isArray(pv) || pv.length === 0) return '';
    let board = fenToBoard(startFen);
    const parts = [];
    let turn = startTurn;
    for (let i = 0; i < pv.length; i++) {
      const m = pv[i];
      if (!m || m.length < 4) break;
      const text = uciToPlain(m, board);
      const own = turn === mySide;
      // UCI 只贴在第 1 手(引擎的实际推荐):后续是延伸预测,不值得再吃横向
      // 空间。要校对翻译只看第一条就够了,翻译库对所有子都一视同仁。
      const uciTag = i === 0
        ? `<span class="xq-ply-uci">(${escapeHtml(m)})</span>`
        : '';
      parts.push(
        `<span class="xq-ply ${own ? 'xq-ply-own' : 'xq-ply-opp'}">` +
          `${escapeHtml(text)}${uciTag}` +
        `</span>`
      );
      board = applyUci(board, m);
      turn = turn === 'red' ? 'black' : 'red';
    }
    return parts.join('<span class="xq-ply-sep">·</span>');
  }

  // Is the first move of this PV actually playable on the current FEN?
  // Used to drop stale lines (engine still returning results for a previous
  // position after we've already updated the board).
  //
  // `turn` = side-to-move in currentFen ('red'|'black'). Engines return PVs
  // from the side-to-move's perspective, so pv[0].from MUST hold a piece of
  // that side. If not, the whole line is stale (the FEN that was analyzed is
  // no longer on the board) — 例:红方两个车已被吃、但引擎还吐着"车前进3"
  // 的 PV,此时该 from 格要么空要么是黑方棋子,都会被这里过滤掉。
  function lineValidOnBoard(line, board, turn) {
    const firstUci = (line.pv || [])[0];
    const p = parseUci(firstUci);
    if (!p) return false;
    const piece = board[p.fy] && board[p.fy][p.fx];
    if (!piece) return false;
    const isRed = piece === piece.toUpperCase();
    if (turn === 'red' && !isRed) return false;
    if (turn === 'black' && isRed) return false;
    return true;
  }

  // 结论文案:cp/mate → "红/黑方 X"。cp 是 side-to-move 视角,先翻到红方客观视角。
  function verdictText(cp, mate, turn) {
    const toRed = (v) => (turn === 'red' ? v : -v);
    if (mate != null) {
      const r = toRed(mate);
      if (r === 0) return { side: '—', tone: 'eq' };
      const who = r > 0 ? '红方' : '黑方';
      return { side: `${who} ${Math.abs(mate)} 步杀`, tone: r > 0 ? 'red' : 'black' };
    }
    if (cp == null) return { side: '—', tone: 'eq' };
    const r = toRed(cp);
    const abs = Math.abs(r);
    if (abs < 30)  return { side: '均势',    tone: 'eq' };
    const who = r > 0 ? '红方' : '黑方';
    const tone = r > 0 ? 'red' : 'black';
    if (abs < 100) return { side: `${who}稍优`,     tone };
    if (abs < 300) return { side: `${who}占优`,     tone };
    if (abs < 600) return { side: `${who}明显优势`, tone };
    return               { side: `${who}胜势`,     tone };
  }

  function renderVerdict(top, turn, mySide) {
    if (!verdictEl) return;
    const v = verdictText(top.cp, top.mate, turn);
    if (verdictSideEl) {
      verdictSideEl.textContent = v.side;
      verdictSideEl.classList.remove('xq-verdict-red', 'xq-verdict-black', 'xq-verdict-eq');
      verdictSideEl.classList.add(`xq-verdict-${v.tone}`);
    }
    if (verdictBestEl) {
      const firstUci = (top.pv || [])[0];
      if (firstUci) {
        verdictBestEl.innerHTML = '最佳：' + (pvToPlainHtml([firstUci], currentFen, turn, mySide) || escapeHtml(firstUci));
      } else {
        verdictBestEl.textContent = '无推荐着';
      }
    }
  }

  function clearVerdict(placeholder) {
    if (!verdictEl) return;
    if (verdictSideEl) {
      verdictSideEl.textContent = '—';
      verdictSideEl.classList.remove('xq-verdict-red', 'xq-verdict-black', 'xq-verdict-eq');
    }
    if (verdictBestEl) verdictBestEl.textContent = placeholder || '等待分析…';
  }

  // -- Render -------------------------------------------------------------
  function renderAnalysis(msg, final) {
    // Drop analyses whose target FEN is no longer the current board. This
    // happens whenever the engine finishes (or emits final info) AFTER the
    // user or opponent has already moved: the PV references pieces at the
    // old position, and labeling it against currentFen mis-identifies the
    // side of each piece — e.g. black's 将 ends up rendered as red's 帥.
    if (analyzingFen && currentFen && analyzingFen !== currentFen) {
      xqLog.push('stale-fen-drop', {
        trace: currentTrace,
        analyzingFen,
        currentFen,
        final
      });
      setStatus('局面已变, 重算中…', 'waiting');
      clearVerdict('局面已变, 重算中…');
      hideHint();
      return;
    }

    lastAnalysisMsg = msg;
    lastAnalysisFinal = final;
    const allLines = (msg.lines || []).slice().sort((a, b) => a.multipv - b.multipv);
    if (allLines.length === 0) return;

    // Drop any line whose first move starts from an empty square in the
    // current FEN — that's a stale result from a just-replaced position.
    const curBoard = fenToBoard(currentFen);
    const lines = allLines.filter(l => lineValidOnBoard(l, curBoard, currentTurn));
    if (lines.length === 0) {
      xqLog.push('stale-all-lines-drop', {
        trace: currentTrace,
        turn: currentTurn,
        droppedFirstMoves: allLines.map(l => (l.pv || [])[0])
      });
      setStatus('局面已变, 重算中…', 'waiting');
      clearVerdict('局面已变, 重算中…');
      hideHint();
      return;
    }

    // Score from #1 line, normalised to player's perspective
    const top = lines[0];
    scoreEl.textContent = formatScore(top.cp, top.mate, currentTurn);
    scoreEl.className = 'xq-score ' + scoreClass(top.cp, top.mate, currentTurn);
    // "红·D12" / "黑·D12 ✓" — 视角和深度折在同一胶囊,省一个字段位
    const persp = effectivePersp() === 'red' ? '红' : '黑';
    metaEl.textContent = `${persp}·D${msg.depth || top.depth || 0}` + (final ? ' ✓' : '');

    // Eval bar: cp/mate 是 side-to-move 视角,先翻成红方客观视角,再 sigmoid 映到 [0,1]。
    // 饱和 @ cp/400 ≈ ±500cp 时 ~77/23。mate → 贴 0/100% 并加 pulse class。
    if (evalBarFillEl) {
      let redShare;
      const toRed = (v) => (currentTurn === 'red' ? v : -v);
      if (top.mate != null) {
        redShare = toRed(top.mate) > 0 ? 1 : 0;
      } else if (top.cp != null) {
        const redCp = toRed(top.cp);
        redShare = 1 / (1 + Math.exp(-redCp / 400));
      } else {
        redShare = 0.5;
      }
      evalBarFillEl.style.width = (redShare * 100).toFixed(1) + '%';
      evalBarEl.classList.toggle('xq-evalbar-mate', top.mate != null);
    }

    const mySide = effectivePersp();
    renderVerdict(top, currentTurn, mySide);
    linesEl.innerHTML = '';
    // Gap 计算以 #1 为基准,后续线越低分 gap 越负。cp/mate 都在 side-to-move
    // 视角,所以可直接相减。任何一侧是 mate 时,gap 不好用数字描述,改给短标注。
    const topCp = top.cp;
    const topMate = top.mate;
    for (const line of lines) {
      const li = document.createElement('li');
      const pv = (line.pv || []).slice(0, 6);
      const html = pvToPlainHtml(pv, currentFen, currentTurn, mySide)
        || escapeHtml(pv.join(' '));
      const sc = formatScore(line.cp, line.mate, currentTurn);
      const scCls = scoreClass(line.cp, line.mate, currentTurn);

      // 标签:#1 → 最佳;#2+ 且与 #1 cp 差 < 30 → 近似;其余无标签。
      // mate 线视为非常规,只给 #1 打标签。
      let tagHtml = '';
      if (line.multipv === 1) {
        tagHtml = '<span class="xq-line-tag xq-line-tag-best">最佳</span>';
      } else if (line.cp != null && topCp != null && topMate == null && line.mate == null) {
        const delta = Math.abs((topCp ?? 0) - (line.cp ?? 0));
        if (delta < 30) tagHtml = '<span class="xq-line-tag xq-line-tag-near">近似</span>';
      }

      // 差距:只对 #2+ 显示。数字比较只在 cp-vs-cp 的常规情况有意义。
      let gapHtml = '';
      if (line.multipv !== 1) {
        if (line.mate != null) {
          gapHtml = `<span class="xq-line-gap">M${line.mate > 0 ? '+' : ''}${line.mate}</span>`;
        } else if (line.cp != null && topCp != null && topMate == null) {
          const d = line.cp - topCp;
          gapHtml = `<span class="xq-line-gap">${d > 0 ? '+' : ''}${d}</span>`;
        }
      }

      li.innerHTML = `
        <span class="xq-line-rank">${line.multipv}</span>
        <div class="xq-line-body">
          <div class="xq-line-pv">${html}</div>
        </div>
        <div class="xq-line-right">
          ${tagHtml}
          <span class="xq-line-score ${scCls}">${sc}</span>
          ${gapHtml}
        </div>
      `;
      linesEl.appendChild(li);
    }

    // Stash the validated lines for the click-to-show-destinations feature.
    window.__xqValidLines = lines.map(l => ({
      uci: (l.pv || [])[0],
      cp: l.cp ?? null,
      mate: l.mate ?? null,
      multipv: l.multipv
    }));
    // 也留一份给"走子对账"用 — 只在我回合,否则对手回合的结果会被
    // 错当成我的建议列表。迁移到对手回合时保留最后一次,等我下一步命中
    // 时消费掉。
    if (currentTurn === effectivePersp() && currentFen) {
      const list = window.__xqValidLines
        .filter(x => x.uci)
        .slice(0, 3)
        .map(x => ({ uci: x.uci, multipv: x.multipv }));
      if (list.length) lastMySuggestions = { fen: currentFen, list };
    }
    // Redraw the on-board arrow now that we have a validated top move.
    renderHint();

    // 日志:把翻译后的中文 + 原始 UCI + 分数一起写进去,复盘时可以
    // 直接看引擎在该局面下吐了什么、哪几条通过了 stale 过滤、以及
    // 中文翻译链是不是和 UCI 对得上(马左右标反之类的 bug 能离线对账)。
    xqLog.push(final ? 'engine-done' : 'engine-progress', {
      trace: currentTrace,
      turn: currentTurn,
      depth: msg.depth || top.depth || 0,
      final,
      mySide,
      lines: lines.map(l => {
        const pv = (l.pv || []).slice(0, 6);
        const zh = [];
        let b = fenToBoard(currentFen), t = currentTurn;
        for (const m of pv) {
          if (!m || m.length < 4) break;
          zh.push(uciToPlain(m, b));
          b = applyUci(b, m);
          t = t === 'red' ? 'black' : 'red';
        }
        return {
          rank: l.multipv,
          cp: l.cp ?? null,
          mate: l.mate ?? null,
          uci: pv,
          zh
        };
      })
    });
  }

  // UCI score is from side-to-move's perspective.
  // We display from the player's chosen perspective:
  //   flip when perspective disagrees with side-to-move
  function formatScore(cp, mate, turn) {
    const flip = effectivePersp() !== turn;
    if (mate != null) {
      const m = flip ? -mate : mate;
      return (m > 0 ? 'M' : '-M') + Math.abs(m);
    }
    if (cp != null) {
      const v = flip ? -cp : cp;
      const n = (v / 100).toFixed(2);
      return (v > 0 ? '+' : '') + n;
    }
    return '—';
  }

  function scoreClass(cp, mate, turn) {
    const flip = effectivePersp() !== turn;
    let v;
    if (mate != null) v = (flip ? -mate : mate) > 0 ? 999 : -999;
    else if (cp != null) v = flip ? -cp : cp;
    else return '';
    if (v > 50) return 'xq-pos';
    if (v < -50) return 'xq-neg';
    return 'xq-eq';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }


  setStatus('引擎加载中…', 'loading');
  showEngineProgress(true);
  // Pull the engine registry so the dropdown can populate. Safe to fire
  // even before background has finished setting up — background ensures
  // offscreen exists before relaying.
  if (ctxAlive()) {
    try {
      chrome.runtime.sendMessage({ to: 'background', type: 'listEngines' }).catch(() => {});
    } catch (_) {}
    // 若 localStorage 已经有用户选过的引擎,和 listEngines 并发发 preload,
    // 省掉一次 "content → bg → offscreen → bg → content → bg → offscreen"
    // 的往返(Pikafish 51MB NNUE 能早 ~500ms 开始下载/加载)。engineList
    // 回来时若发现这个 id 和注册表对不上,会再补发一次 preload,所以这里
    // 不用判空注册表。
    if (selectedEngineId) {
      xqLog.push('engine-preload', { engineId: selectedEngineId, early: true });
      try {
        chrome.runtime.sendMessage({
          to: 'background', type: 'preload', engineId: selectedEngineId
        }).catch(() => {});
        preloadedEngineId = selectedEngineId;
      } catch (_) {}
    }
  }
  console.log('[XQ-Analyzer] overlay mounted');
})();
