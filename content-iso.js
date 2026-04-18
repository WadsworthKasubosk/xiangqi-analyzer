/* ISOLATED-world content script.
 * - Mounts the floating analysis panel
 * - Forwards FEN updates (received via CustomEvent from MAIN script) to background
 * - Receives analysis results from background and renders them
 */
(function () {
  if (window.__XQ_OVERLAY__) return;
  window.__XQ_OVERLAY__ = true;

  const DEFAULT_MOVE_TIME = 1000; // user-confirmed: fixed 1 second
  const PERSP_KEY = 'xq.perspective'; // 'auto' | 'red' | 'black'
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
      <span class="xq-title">XQ Analyzer</span>
      <span class="xq-status" id="xq-status">loading…</span>
      <button class="xq-btn" id="xq-persp" title="切换视角 (评分归一化到哪一方) 自动 → 红 → 黑">自动</button>
      <button class="xq-btn" id="xq-feedback" title="记录反馈(自动附带当前 FEN + 最近分析) · 控制台:__xqLog.feedback('内容')">✎</button>
      <button class="xq-btn" id="xq-log" title="下载完整日志 (JSON) · 控制台:__xqLog.dump()">⤓</button>
      <button class="xq-btn" id="xq-toggle" title="Pause/Resume">⏸</button>
      <button class="xq-btn" id="xq-collapse" title="Collapse">─</button>
    </div>
    <div class="xq-body">
      <div class="xq-score-row">
        <span class="xq-score" id="xq-score">—</span>
        <span class="xq-meta" id="xq-meta" title="评分视角 · 搜索深度 (正=对该视角方有利)">—·D0</span>
      </div>
      <div class="xq-mover" id="xq-mover" title="当前该哪一方走棋 · 下方建议即该方的着法">
        <span class="xq-mover-dot"></span>
        <span class="xq-mover-text">等待局面…</span>
      </div>
      <ol class="xq-lines" id="xq-lines">
        <li class="xq-empty">waiting for engine…</li>
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
  const toggleBtn = $('xq-toggle');
  const collapseBtn = $('xq-collapse');
  const perspBtn = $('xq-persp');
  const logBtn = $('xq-log');
  const feedbackBtn = $('xq-feedback');
  const fenEl = $('xq-fen');

  if (logBtn) {
    logBtn.addEventListener('click', () => {
      xqLog.push('log-download', { size: xqLog.buf.length });
      xqLog.download();
      setStatus(`log saved (${xqLog.buf.length})`);
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
      if (entry) setStatus('feedback ✓');
      else setStatus('feedback empty');
    });
  }

  fenEl.addEventListener('click', () => {
    if (!currentFen) return;
    try { navigator.clipboard.writeText(currentFen); } catch (_) {}
    setStatus('FEN copied');
  });

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
    // Perspective flip may swap whose turn it is → re-decide analyze/hold
    if (enabled && currentFen) {
      if (isMyTurn()) requestAnalyze(currentFen);
      else { stopAnalyze(); setStatus('等对方走'); }
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
      setStatus('paused');
      return;
    }
    if (currentFen && isMyTurn()) {
      requestAnalyze(currentFen);
    } else if (currentFen) {
      setStatus('等对方走');
    } else {
      setStatus(engineReady ? 'idle' : 'loading…');
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
  function setStatus(s) { statusEl.textContent = s; }

  document.addEventListener('xq:fen', (ev) => {
    const detail = ev.detail || {};
    const { fen, turn } = detail;
    if (!fen) return;
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
      setStatus('等对方走');
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
    setStatus('reload page');
    linesEl.innerHTML =
      '<li class="xq-empty">扩展已重载,请刷新本页面 (F5)</li>';
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
      setStatus(engineReady ? 'thinking…' : 'loading…');
      // Reset display while we wait for first info
      linesEl.innerHTML = '<li class="xq-empty">analyzing…</li>';
      analyzingFen = fen;
      analyzingTurn = currentTurn;
      xqLog.push('engine-dispatch', {
        trace: currentTrace,
        turn: currentTurn,
        moveTime: DEFAULT_MOVE_TIME,
        fen
      });
      console.log(
        `[XQ-Overlay] → engine mc=${currentMeta?.moveCount} turn=${currentTurn}\n  ${fen}`
      );
      try {
        chrome.runtime.sendMessage({
          to: 'background',
          type: 'analyze',
          fen,
          moveTime: DEFAULT_MOVE_TIME
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
    if (!ctxAlive()) return;
    try {
      chrome.runtime.sendMessage({ to: 'background', type: 'stop' }).catch(() => {});
    } catch (_) {}
  }

  if (!ctxAlive()) { showContextLost(); return; }
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.to !== 'content') return;
    switch (msg.type) {
      case 'engineReady':
        engineReady = true;
        xqLog.push('engine-ready', {});
        setStatus(enabled ? 'idle' : 'paused');
        // If we already have a FEN waiting, kick off analysis now
        if (enabled && currentFen) {
          if (isMyTurn()) requestAnalyze(currentFen);
          else setStatus('等对方走');
        } else if (!currentFen) {
          // Ask MAIN world to re-poll
          document.dispatchEvent(new CustomEvent('xq:request-fen'));
        }
        break;
      case 'engineError':
        xqLog.push('engine-error', { message: msg.message || '' });
        setStatus('engine error');
        linesEl.innerHTML = `<li class="xq-empty">engine error: ${escapeHtml(msg.message || '')}</li>`;
        break;
      case 'analysisProgress':
        renderAnalysis(msg, /*final*/ false);
        break;
      case 'analysisDone':
        renderAnalysis(msg, /*final*/ true);
        setStatus('done');
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
      setStatus('stale · waiting…');
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
      setStatus('stale · waiting…');
      return;
    }

    // Score from #1 line, normalised to player's perspective
    const top = lines[0];
    scoreEl.textContent = formatScore(top.cp, top.mate, currentTurn);
    scoreEl.className = 'xq-score ' + scoreClass(top.cp, top.mate, currentTurn);
    // "红·D12" / "黑·D12 ✓" — 视角和深度折在同一胶囊,省一个字段位
    const persp = effectivePersp() === 'red' ? '红' : '黑';
    metaEl.textContent = `${persp}·D${msg.depth || top.depth || 0}` + (final ? ' ✓' : '');

    const mySide = effectivePersp();
    linesEl.innerHTML = '';
    for (const line of lines) {
      const li = document.createElement('li');
      const pv = (line.pv || []).slice(0, 6);
      const html = pvToPlainHtml(pv, currentFen, currentTurn, mySide)
        || escapeHtml(pv.join(' '));
      const sc = formatScore(line.cp, line.mate, currentTurn);
      li.innerHTML = `
        <span class="xq-line-rank">${line.multipv}</span>
        <span class="xq-line-score ${scoreClass(line.cp, line.mate, currentTurn)}">${sc}</span>
        <span class="xq-line-pv">${html}</span>
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


  setStatus('loading…');
  console.log('[XQ-Analyzer] overlay mounted');
})();
