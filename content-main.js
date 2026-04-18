/* MAIN-world content script.
 * Polls React Fiber on the board element to extract current FEN.
 * Dispatches a CustomEvent('xq:fen', {detail: {fen, turn, moveCount, gameId}}) on document
 * whenever the FEN changes. The ISOLATED-world script picks it up and forwards
 * to the engine.
 */
(function () {
  if (window.__XQ_FEN_PROBE__) return;
  window.__XQ_FEN_PROBE__ = true;

  let lastKey = null; // fen + moveCount + activeMove index — avoid stale dedup
  const DEBUG = true; // flip to false to silence [XQ-Analyzer] logs
  // Player-side detection cache. Layout rarely changes, so we only re-probe
  // the DOM every few seconds or when the fiber lookup fails.
  let cachedPlayerSide = null; // 'red' | 'black' | null
  let cachedAt = 0;
  const PLAYER_SIDE_TTL = 5000;

  // Walk a fiber upward looking for memoizedProps.user?.side or player?.side.
  // Returns 1 (red) / 2 (black) / null.
  function fiberFindSide(fiber) {
    let f = fiber;
    let depth = 0;
    while (f && depth < 20) {
      const p = f.memoizedProps;
      if (p) {
        const s =
          p.user?.side ??
          p.player?.side ??
          p.gamePlayer?.side ??
          null;
        if (s === 1 || s === 2) return s;
      }
      f = f.return;
      depth++;
    }
    return null;
  }

  // Pick the avatar at the bottom of the viewport (= player's own avatar on
  // play.xiangqi.com), walk its React fiber to read `user.side`, map 1→red /
  // 2→black. Returns null if the DOM/fiber shape is unexpected.
  function detectPlayerSide() {
    const now = Date.now();
    if (cachedPlayerSide && now - cachedAt < PLAYER_SIDE_TTL) {
      return cachedPlayerSide;
    }
    try {
      const avatars = Array.from(
        document.querySelectorAll('.board-avatar-link, [class*="board-avatar"]')
      );
      if (avatars.length < 2) return null;
      avatars.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const bottom = avatars[avatars.length - 1];
      const key = Object.keys(bottom).find(
        (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
      );
      if (!key) return null;
      const side = fiberFindSide(bottom[key]);
      if (side === 1) { cachedPlayerSide = 'red'; cachedAt = now; return 'red'; }
      if (side === 2) { cachedPlayerSide = 'black'; cachedAt = now; return 'black'; }
    } catch (_) { /* ignore */ }
    return null;
  }

  // Walk one fiber chain upward, return the first memoizedProps carrying
  // boardContext.fen (or null).
  function walkForBoard(start) {
    let fiber = start;
    let depth = 0;
    while (fiber && depth < 40) {
      const p = fiber.memoizedProps;
      if (p && p.boardContext && p.boardContext.fen) return p;
      fiber = fiber.return;
      depth++;
    }
    return null;
  }

  // React has two fiber trees (current + alternate); a given DOM node
  // can also be reached through multiple ancestors whose memoizedProps were
  // committed at different times. Picking the FIRST match risks pinning a
  // stale snapshot — instead, collect every hit and keep the one with the
  // highest moveCount (freshest).
  function readBoardProps() {
    const candidates = document.querySelectorAll('[class*="board"], [class*="Board"]');
    let best = null;
    let bestMove = -1;
    for (const node of candidates) {
      const key = Object.keys(node).find(
        (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
      );
      if (!key) continue;
      const roots = [node[key], node[key] && node[key].alternate];
      for (const r of roots) {
        const p = walkForBoard(r);
        if (!p) continue;
        const mc = p.gamePlayData?.moveCount ?? 0;
        if (mc >= bestMove) { bestMove = mc; best = p; }
      }
    }
    return best;
  }

  // 合法性:严格校验
  //   - 非空字符串
  //   - 以 " " 分隔取 board 部分
  //   - 10 行以 "/" 分隔
  //   - 每行字符只允许 RNBAKCP(含小写)或 1-9 数字
  //   - 每行数字+字母累加 = 9
  //   - 必须恰好一个红王 K 和一个黑王 k(排除空局 / 截断态)
  const FEN_VALID_CH = /^[rnbakcpRNBAKCP1-9]$/;
  // 象棋每方棋子上限:将1 士2 象2 马2 车2 炮2 兵5 (= 16 开局)
  const MAX_PER_SIDE = { K: 1, A: 2, B: 2, N: 2, R: 2, C: 2, P: 5 };
  function validateFen(s) {
    if (typeof s !== 'string' || !s) return { ok: false, why: 'not a string' };
    const boardPart = s.split(' ')[0];
    const rows = boardPart.split('/');
    if (rows.length !== 10) return { ok: false, why: `rows=${rows.length}` };
    const count = { R: {}, B: {} }; // R=red uppercase, B=black lowercase
    for (let i = 0; i < rows.length; i++) {
      let sum = 0;
      for (const ch of rows[i]) {
        if (!FEN_VALID_CH.test(ch)) return { ok: false, why: `行${i}含非法字符"${ch}": "${rows[i]}"` };
        if (ch >= '1' && ch <= '9') {
          sum += parseInt(ch, 10);
        } else {
          sum += 1;
          const bucket = ch === ch.toUpperCase() ? count.R : count.B;
          const key = ch.toUpperCase();
          bucket[key] = (bucket[key] || 0) + 1;
        }
        // 过早出界就直接判错,避免在行中段累成奇怪的总和再报告
        if (sum > 9) return { ok: false, why: `行${i}越界(>${9}): "${rows[i]}"` };
      }
      if (sum !== 9) return { ok: false, why: `行${i}长度=${sum}: "${rows[i]}"` };
    }
    if ((count.R.K || 0) !== 1 || (count.B.K || 0) !== 1) {
      return { ok: false, why: `王/将数量异常 (K=${count.R.K||0}, k=${count.B.K||0})` };
    }
    // 任一类棋子超额 → FEN 结构错乱,即使行宽合法也不可信
    for (const side of ['R', 'B']) {
      for (const [k, max] of Object.entries(MAX_PER_SIDE)) {
        const n = count[side][k] || 0;
        if (n > max) return { ok: false, why: `${side === 'R' ? '红' : '黑'}${k}=${n} 超过上限 ${max}` };
      }
    }
    return { ok: true };
  }
  let badFenReported = null;
  let consecutiveBad = 0;
  let retryTimer = null;
  let lastValidFen = null;

  function poll() {
    let props;
    try {
      props = readBoardProps();
    } catch (e) {
      // React internals can throw transiently during rerenders — ignore.
      return;
    }
    if (!props) return;

    const fen = props.boardContext.fen;

    // FEN 自检;非法 → bail,不清屏、不 dispatch、沿用上一次合法 FEN
    const chk = validateFen(fen);
    if (!chk.ok) {
      consecutiveBad++;
      if (badFenReported !== fen) {
        badFenReported = fen;
        console.warn(
          `[XQ-Analyzer] ⚠ 非法 FEN 已拒绝 (连续 ${consecutiveBad} 次)。` +
          `运行 __xqProbe.dumpProps() 查完整 props。\n` +
          `  原因: ${chk.why}\n  raw fen: ${JSON.stringify(fen)}`
        );
        // 同步到 overlay,让用户肉眼看到拦截 (否则 debug bar 会保持旧 FEN,
        // 容易让人误以为 validateFen 没干活)
        try {
          document.dispatchEvent(new CustomEvent('xq:fen-reject', {
            detail: { rawFen: String(fen), why: chk.why, consecutiveBad }
          }));
        } catch (_) {}
      }
      // 连续 3 次非法 → 等 500ms 重试(可能 React 状态中途提交,让它稳定下)
      if (consecutiveBad >= 3 && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          lastKey = null; // 强制下一轮重新读
          poll();
        }, 500);
      }
      return;
    }
    // 本次合法 → 重置计数
    consecutiveBad = 0;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    lastValidFen = fen;
    badFenReported = null;

    const gp = props.gamePlayers || {};
    const gpd = props.gamePlayData || {};
    const gd = props.gameData || {};
    const mc = gpd.moveCount;
    const mi = props.activeMove?.index ?? null;
    const key = `${fen}|${mc}|${mi}`;
    if (key === lastKey) return;
    lastKey = key;

    const turn = (fen.split(' ')[1] || 'r') === 'r' ? 'red' : 'black';
    if (DEBUG) {
      console.log(
        `[XQ-Analyzer] FEN dispatch mc=${mc} idx=${mi} turn=${turn}\n  ${fen}`
      );
    }
    const detail = {
      fen,
      turn,
      moveCount: gpd.moveCount,
      gameId: gd.gameID,
      state: gpd.state,
      lastMove: props.activeMove?.uci ?? null,
      moveIndex: props.activeMove?.index ?? null,
      players: {
        red: gp.red ? {
          username: gp.red.username ?? null,
          rating: gp.red.rating ?? gp.red.backendRating ?? null
        } : null,
        black: gp.black ? {
          username: gp.black.username ?? null,
          rating: gp.black.rating ?? gp.black.backendRating ?? null
        } : null
      },
      // Best-effort: some builds use 'winner', others 'result' / 'endReason'
      winner: gpd.winner ?? gd.winner ?? null,
      result: gpd.result ?? gd.result ?? null,
      endReason: gpd.endReason ?? gd.endReason ?? null,
      // Which side the local user is playing (bottom avatar). Null if unknown.
      playerSide: detectPlayerSide(),
    };
    document.dispatchEvent(new CustomEvent('xq:fen', { detail }));
  }

  // Poll every 300ms. React Fiber lookup is cheap when nothing has changed.
  setInterval(poll, 300);
  // Run once immediately so the panel can show eval as soon as it mounts.
  setTimeout(poll, 1000);

  // WebSocket move events cause React state commits in multiple frames —
  // a single poll can catch the commit mid-flight. React schedules renders
  // via requestAnimationFrame, so piggy-back on rAF for a short burst after
  // we notice ANY change signal in gamePlayData.moveCount.
  let lastMoveCountSeen = null;
  function rafBurst() {
    let i = 0;
    function tick() {
      poll();
      if (++i < 4) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  setInterval(() => {
    try {
      const p = readBoardProps();
      const mc = p?.gamePlayData?.moveCount ?? null;
      if (mc != null && mc !== lastMoveCountSeen) {
        lastMoveCountSeen = mc;
        rafBurst();
      }
    } catch (_) {}
  }, 150);

  // Allow ISOLATED side to force a re-read (e.g. on overlay open).
  document.addEventListener('xq:request-fen', () => {
    lastKey = null;
    poll();
  });

  // -- __xqProbe: 采样棋盘 DOM ,用于"点棋子看建议落点"功能落地 --------------
  // MAIN world,所以在 devtools console 里可直接调用。
  // 用法:
  //   __xqProbe()            → 捕获下一次点击并打印命中元素 + 棋盘候选 + 棋子清单
  //   __xqProbe.scan()       → 立刻扫描棋盘结构 + 全部棋子位置(不需要点击)
  window.__xqProbe = function () {
    console.log('[XQ-Probe] 请在棋盘上点任一棋子(仅捕获一次)');
    function oneShot(e) {
      document.removeEventListener('click', oneShot, true);
      e.stopPropagation();
      e.preventDefault();
      const t = e.target;
      const path = [];
      let el = t;
      while (el && el !== document.body) {
        const cls = typeof el.className === 'string' && el.className
          ? '.' + el.className.split(/\s+/).filter(Boolean).join('.')
          : '';
        path.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}`);
        el = el.parentElement;
      }
      // 往上找"格点数 ≥ 16"的祖先作为棋盘候选
      let board = null;
      el = t;
      while (el && el !== document.body) {
        if (el.children && el.children.length >= 16) board = el;
        el = el.parentElement;
      }
      console.group('[XQ-Probe] 点击命中');
      console.log('target:', t);
      console.log('  tag:', t.tagName, 'id:', t.id, 'class:', t.className);
      console.log('  rect:', t.getBoundingClientRect());
      console.log('  text:', (t.textContent || '').slice(0, 20));
      if (t.style) console.log('  inline style: left=', t.style.left, 'top=', t.style.top, 'transform=', t.style.transform);
      console.log('  bg-image:', getComputedStyle(t).backgroundImage);
      console.log('path(≤10层):', path.slice(0, 10).join(' > '));
      console.log('likelyBoard:', board);
      if (board) {
        const br = board.getBoundingClientRect();
        console.log('  boardRect:', br);
        console.log('  children.length:', board.children.length);
        console.log('  child[0..2]:', Array.from(board.children).slice(0, 3));
      }
      console.log('click coords:', { x: e.clientX, y: e.clientY });
      console.groupEnd();
      __xqProbe.scan(board);
    }
    document.addEventListener('click', oneShot, true);
  };

  // 直接扫描:从"棋子元素"反推棋盘容器。
  // 棋子判定条件(宽松):
  //   - textContent trim 后是单个中文棋子字符
  //   - 或 class 包含 piece/chess/stone/soldier 之类关键字
  //   - 或 img + alt 是棋子字
  //   - 或 data-piece / data-type 有值
  window.__xqProbe.scan = function () {
    const PIECE_CHARS = /^[帥仕相馬車炮兵將士象馬車砲卒俥傌炮帅将帥]$/;
    const PIECE_CHARS_LOOSE = /[帥仕相馬車炮兵将士象马车砲卒俥傌]/;
    const PIECE_CLS_RE = /(piece|chess|stone|soldier|chesspiece|xiangqi-piece|board-piece)/i;

    const all = document.querySelectorAll('*');
    const pieceEls = [];
    for (const el of all) {
      const txt = (el.textContent || '').trim();
      const cls = typeof el.className === 'string' ? el.className : '';
      const alt = el.getAttribute?.('alt') || '';
      const dp = el.dataset?.piece || el.dataset?.type || el.dataset?.chess;
      const isText = txt.length === 1 && PIECE_CHARS_LOOSE.test(txt) && el.children.length === 0;
      const isCls = cls && PIECE_CLS_RE.test(cls);
      const isImg = el.tagName === 'IMG' && PIECE_CHARS_LOOSE.test(alt);
      const isData = !!dp;
      if (isText || isCls || isImg || isData) {
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) continue;
        pieceEls.push({ el, txt, cls, alt, dp, r });
      }
    }
    console.group('[XQ-Probe.scan] 棋子候选');
    console.log('总数:', pieceEls.length);
    if (pieceEls.length === 0) {
      console.log('一个都没找到。补救:运行 __xqProbe.dumpDom() 导出整页 DOM 摘要');
      console.groupEnd();
      return;
    }
    console.table(
      pieceEls.slice(0, 40).map((p) => ({
        tag: p.el.tagName,
        text: p.txt,
        alt: p.alt,
        dp: p.dp || '',
        cls: String(p.cls).slice(0, 50),
        x: Math.round(p.r.x),
        y: Math.round(p.r.y),
        w: Math.round(p.r.width),
        h: Math.round(p.r.height),
      }))
    );
    console.groupEnd();

    // 求所有棋子元素的最近公共祖先作为棋盘
    function commonAncestor(nodes) {
      if (nodes.length === 0) return null;
      const paths = nodes.map((n) => {
        const p = [];
        let x = n;
        while (x) { p.push(x); x = x.parentElement; }
        return p.reverse(); // root → node
      });
      const min = Math.min(...paths.map((p) => p.length));
      let ca = null;
      for (let i = 0; i < min; i++) {
        const ref = paths[0][i];
        if (paths.every((p) => p[i] === ref)) ca = ref;
        else break;
      }
      return ca;
    }
    const ca = commonAncestor(pieceEls.map((p) => p.el));
    console.group('[XQ-Probe.scan] 棋盘(最近公共祖先)');
    console.log('board:', ca);
    if (ca) {
      const br = ca.getBoundingClientRect();
      console.log('rect:', br);
      console.log('tag:', ca.tagName, 'id:', ca.id, 'class:', ca.className);
      console.log('children.length:', ca.children.length);
      console.log('棋子在棋盘坐标系里的位置:');
      console.table(
        pieceEls.slice(0, 40).map((p) => ({
          text: p.txt,
          alt: p.alt,
          dp: p.dp || '',
          cls: String(p.cls).slice(0, 40),
          x: Math.round(p.r.x - br.x),
          y: Math.round(p.r.y - br.y),
          w: Math.round(p.r.width),
          h: Math.round(p.r.height),
        }))
      );
      // 采样一个棋子,打出它的 inline style / dataset 全貌
      const sample = pieceEls[0].el;
      console.log('sample piece:', sample);
      console.log('  outerHTML:', sample.outerHTML.slice(0, 300));
      console.log('  inline style.cssText:', sample.style?.cssText);
      console.log('  dataset:', { ...sample.dataset });
      const cs = getComputedStyle(sample);
      console.log('  computed position/left/top/transform:', cs.position, cs.left, cs.top, cs.transform);
    }
    console.groupEnd();
  };

  // 关键诊断:dump 当前 React Fiber 读出来的 props,看 boardContext.fen 究竟
  // 是不是合法 FEN,以及是否有更可靠的字段(比如 position / currentFen / pieces
  // 数组)。合法象棋 FEN: 10 行以 "/" 分隔,每行数字+字母累加 = 9,字母只出现
  // R N B A K C P r n b a k c p。
  window.__xqProbe.dumpProps = function () {
    const props = (function () {
      const candidates = document.querySelectorAll('[class*="board"], [class*="Board"]');
      for (const node of candidates) {
        const key = Object.keys(node).find(
          (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        if (!key) continue;
        let fiber = node[key];
        let depth = 0;
        while (fiber && depth < 40) {
          const p = fiber.memoizedProps;
          if (p && p.boardContext) return { props: p, fiber, node };
          fiber = fiber.return;
          depth++;
        }
      }
      return null;
    })();
    if (!props) { console.log('未找到 boardContext'); return; }

    console.group('[XQ-Probe.dumpProps] 根 props');
    console.log('boardContext keys:', Object.keys(props.props.boardContext || {}));
    console.log('boardContext:', props.props.boardContext);
    const bc = props.props.boardContext;

    // 自检:boardContext.fen 合法吗?
    function fenLooksValid(s) {
      if (typeof s !== 'string' || !s) return { ok: false, why: 'not a string' };
      const fenPart = s.split(' ')[0];
      const rows = fenPart.split('/');
      if (rows.length !== 10) return { ok: false, why: `rows=${rows.length} (应 10)` };
      const VALID_PIECE = /^[rnbakcpRNBAKCP1-9]$/;
      for (let i = 0; i < rows.length; i++) {
        let sum = 0;
        for (const ch of rows[i]) {
          if (!VALID_PIECE.test(ch)) return { ok: false, why: `行 ${i} 含非法字符 "${ch}"` };
          if (ch >= '1' && ch <= '9') sum += parseInt(ch, 10);
          else sum += 1;
        }
        if (sum !== 9) return { ok: false, why: `行 ${i} 长度=${sum} (应 9): "${rows[i]}"` };
      }
      return { ok: true };
    }
    console.log('boardContext.fen =', JSON.stringify(bc?.fen));
    console.log('合法性检查:', fenLooksValid(bc?.fen));

    // 把所有看起来像 FEN 或位置数据的字段都列出来
    console.group('[XQ-Probe.dumpProps] 候选字段扫描');
    const seen = new Set();
    function scan(obj, path, depth) {
      if (depth > 4) return;
      if (!obj || typeof obj !== 'object') return;
      if (seen.has(obj)) return;
      seen.add(obj);
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        const fullPath = path ? `${path}.${k}` : k;
        if (typeof v === 'string' && v.length > 0 && v.length < 200) {
          // 字段名暗示 FEN / position
          const looksFenField = /fen|position|board|pos/i.test(k);
          const hasSlashes = v.includes('/') && v.split('/').length >= 8;
          if (looksFenField || hasSlashes) {
            const ok = fenLooksValid(v);
            console.log(`  ${fullPath} =`, JSON.stringify(v), '合法?', ok);
          }
        } else if (Array.isArray(v)) {
          if (v.length > 0 && v.length < 100 && typeof v[0] === 'object') {
            console.log(`  ${fullPath} = Array(${v.length}), [0]:`, v[0]);
          }
        } else if (typeof v === 'object' && v !== null) {
          scan(v, fullPath, depth + 1);
        }
      }
    }
    scan(props.props, '', 0);
    console.groupEnd();

    // 列出所有叶子键(帮助找比如 pieceList / squares / grid 这类)
    console.group('[XQ-Probe.dumpProps] props 顶层所有字段');
    for (const k of Object.keys(props.props)) {
      const v = props.props[k];
      const t = Array.isArray(v) ? `Array(${v.length})` : typeof v;
      console.log(`  ${k}: ${t}`, v && typeof v === 'object' ? v : '');
    }
    console.groupEnd();
    console.groupEnd();
    console.log('→ 把 boardContext: {...} 展开截图,以及"候选字段扫描"的全部输出贴给我');
  };

  // 定向:已知 BoardBorder 是棋盘,把它底下的所有子孙节点摘要 dump 出来,
  // 看棋子究竟长什么样。
  window.__xqProbe.inspectBoard = function (selector) {
    const board = selector
      ? document.querySelector(selector)
      : document.querySelector(
          '[class*="BoardBorder"], [class*="board-border"], [class*="BoardContainer"], .board-wrapper-main'
        );
    if (!board) { console.log('未找到棋盘元素,手动传 selector'); return; }
    const br = board.getBoundingClientRect();
    console.log('board:', board, 'rect:', br);
    const rows = [];
    const walk = (el, depth) => {
      if (depth > 6) return;
      for (const child of el.children) {
        const r = child.getBoundingClientRect();
        const txt = (child.textContent || '').trim().slice(0, 6);
        const bg = getComputedStyle(child).backgroundImage;
        rows.push({
          depth,
          tag: child.tagName,
          cls: String(child.className).slice(0, 60),
          text: txt,
          id: child.id,
          w: Math.round(r.width),
          h: Math.round(r.height),
          x: Math.round(r.x - br.x),
          y: Math.round(r.y - br.y),
          kids: child.children.length,
          bg: bg === 'none' ? '' : bg.slice(0, 60),
          style: (child.style?.cssText || '').slice(0, 80),
          data: Object.keys(child.dataset || {}).join(','),
        });
        walk(child, depth + 1);
      }
    };
    walk(board, 0);
    console.log(`子孙元素总数: ${rows.length}`);
    console.table(rows.slice(0, 80));
    // 额外:采样一个最可能是"棋子"的叶子节点的完整 outerHTML
    const leaves = rows.filter((r) => r.kids === 0 && r.w >= 15 && r.w <= 80);
    console.log(`叶子尺寸 15-80 的候选棋子: ${leaves.length}`);
    if (leaves.length > 0) {
      const sample = leaves[0];
      console.log('第一个叶子候选 row:', sample);
    }
  };

  // 兜底:如果棋子检测一个都没命中,把整页结构大致 dump 出来
  window.__xqProbe.dumpDom = function () {
    console.group('[XQ-Probe.dumpDom] 大于 200x200 的块级元素');
    const all = document.querySelectorAll('body *');
    const rows = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      rows.push({
        tag: el.tagName,
        id: el.id,
        cls: String(el.className).slice(0, 60),
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: Math.round(r.x),
        y: Math.round(r.y),
        children: el.children.length,
      });
    }
    console.table(rows.slice(0, 40));
    console.groupEnd();
  };

  console.log('[XQ-Analyzer] FEN probe armed. 棋盘结构采样: __xqProbe() / __xqProbe.scan()');
})();
