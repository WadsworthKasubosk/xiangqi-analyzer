/* Dashboard: list of recorded games + minimal detail view.
 * Data lives in chrome.storage.local under key 'xq.games'.
 * Routing: hash-based. '#/' = list, '#/game/<id>' = detail.
 */
(function () {
  const GAMES_KEY = 'xq.games';
  const viewEl = document.getElementById('xq-view');
  const countEl = document.getElementById('xq-count');

  // ---- Data ------------------------------------------------------------
  async function loadGames() {
    const s = await chrome.storage.local.get(GAMES_KEY);
    const map = s[GAMES_KEY] || {};
    return Object.values(map);
  }
  async function clearAll() {
    if (!confirm('确定清空所有对局记录?')) return;
    await chrome.storage.local.remove(GAMES_KEY);
    route();
  }

  // ---- Formatting ------------------------------------------------------
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function opponentOf(g) {
    const r = g.players?.red?.username || '';
    const b = g.players?.black?.username || '';
    // Heuristic: the non-"Anonymous" side is probably the opponent
    if (r && r !== 'Anonymous') return b === 'Anonymous' ? r : `${r} vs ${b}`;
    if (b && b !== 'Anonymous') return b;
    return r || b || '—';
  }
  function resultOf(g) {
    if (g.winner === 'red') return '红胜';
    if (g.winner === 'black') return '黑胜';
    if (g.result === 'draw' || g.winner === 'draw') return '和';
    if (g.endTime) return '已完';
    return '进行中';
  }
  function scoreOf(cp, mate) {
    if (mate != null) return (mate > 0 ? 'M' : '-M') + Math.abs(mate);
    if (cp == null) return '—';
    return (cp > 0 ? '+' : '') + (cp / 100).toFixed(2);
  }

  // ---- UCI → 白话 (duplicated from content-iso for standalone page) -----
  const PIECE_NAME = {
    'K':'帥','A':'仕','B':'相','N':'馬','R':'車','C':'炮','P':'兵',
    'k':'将','a':'士','b':'象','n':'马','r':'车','c':'砲','p':'卒'
  };
  const UCI_RE = /^([a-i])(\d{1,2})([a-i])(\d{1,2})$/;
  function parseUci(uci) {
    const m = uci && uci.match(UCI_RE);
    if (!m) return null;
    const fx = m[1].charCodeAt(0) - 97;
    const fy = parseInt(m[2],10) - 1;
    const tx = m[3].charCodeAt(0) - 97;
    const ty = parseInt(m[4],10) - 1;
    if (fy<0||fy>9||ty<0||ty>9) return null;
    return { fx, fy, tx, ty };
  }
  function fenToBoard(fen) {
    const board = Array.from({length:10}, () => Array(9).fill(null));
    if (!fen) return board;
    const rows = fen.split(' ')[0].split('/');
    for (let i=0;i<rows.length;i++) {
      const rank = 9 - i;
      let file = 0;
      for (const ch of rows[i]) {
        if (ch>='1'&&ch<='9') file += parseInt(ch,10);
        else { if (rank>=0&&rank<=9&&file<=8) board[rank][file] = ch; file++; }
      }
    }
    return board;
  }
  function disambiguate(board, piece, fx, fy, isRed) {
    const same = [];
    for (let r=0;r<10;r++) for (let f=0;f<9;f++) if (board[r][f]===piece) same.push({f,r});
    if (same.length<=1) return '';
    const onFile = same.filter(s => s.f===fx);
    if (onFile.length>=2) {
      onFile.sort((a,b)=> isRed ? b.r-a.r : a.r-b.r);
      const idx = onFile.findIndex(s => s.r===fy);
      const n = onFile.length;
      if (n===2) return idx===0 ? '前' : '后';
      if (n===3) return ['前','中','后'][idx];
      // 4-5 pawns on same file: 前/二/三/四/后
      if (idx===0) return '前';
      if (idx===n-1) return '后';
      return ['','','二','三','四'][idx+1] || '中';
    }
    const byFile = same.slice().sort((a,b)=> isRed ? a.f-b.f : b.f-a.f);
    const idx = byFile.findIndex(s => s.f===fx && s.r===fy);
    const n = same.length;
    if (n===2) return idx===0 ? '左' : '右';
    if (n===3) return ['左','中','右'][idx];
    // 4-5 pawns across files: "N路" (player-side file number uniquely identifies)
    const fileNum = isRed ? (9 - fx) : (fx + 1);
    return fileNum + '路';
  }
  function uciToPlain(uci, board) {
    const p = parseUci(uci);
    if (!p) return uci || '??';
    const piece = board[p.fy]?.[p.fx];
    if (!piece) return '??';
    const name = PIECE_NAME[piece] || piece;
    const isRed = piece === piece.toUpperCase();
    const prefix = disambiguate(board, piece, p.fx, p.fy, isRed);
    const label = prefix + name;
    const dx = p.tx - p.fx, dy = p.ty - p.fy;
    const forward = isRed ? dy : -dy;
    const right = isRed ? dx : -dx;
    const vert = forward>0 ? '前' : '后';
    const horz = right>0 ? '右' : '左';
    const type = piece.toUpperCase();
    if (type==='N') return `${label}${horz}${vert}跳`;
    if (type==='B') return `${label}${horz}${vert}飞`;
    if (type==='A') return `${label}${horz}${vert}`;
    if (dx===0) return `${label}${forward>0?'前进':'后退'}${Math.abs(forward)}`;
    if (dy===0) return `${label}${right>0?'右平':'左平'}${Math.abs(right)}`;
    return `${label}${horz}${vert}`;
  }

  // ---- Views -----------------------------------------------------------
  function h(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function renderList() {
    const games = await loadGames();
    // Sort by startTime desc
    games.sort((a,b) => (b.startTime||0) - (a.startTime||0));
    countEl.textContent = `${games.length} 局`;

    if (games.length === 0) {
      viewEl.innerHTML = `
        <div class="xq-empty-state">
          <p>还没有对局记录。</p>
          <p>打开 <code>play.xiangqi.com</code> 并下一盘棋,记录会自动保存在浏览器本地。</p>
        </div>`;
      return;
    }

    const table = h(`
      <table class="xq-table">
        <thead>
          <tr>
            <th>开始时间</th>
            <th>对手</th>
            <th>步数</th>
            <th>结果</th>
            <th>最终评分</th>
            <th></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    `);
    const tbody = table.querySelector('tbody');
    for (const g of games) {
      const last = g.moves[g.moves.length - 1];
      const lastEval = last ? scoreOf(last.cp, last.mate) : '—';
      const tr = h(`
        <tr data-id="${esc(g.gameId)}">
          <td>${esc(fmtDate(g.startTime))}</td>
          <td>${esc(opponentOf(g))}</td>
          <td>${g.moves.length}</td>
          <td>${esc(resultOf(g))}</td>
          <td>${esc(lastEval)}</td>
          <td><a href="#/game/${encodeURIComponent(g.gameId)}">详情 →</a></td>
        </tr>
      `);
      tbody.appendChild(tr);
    }
    viewEl.innerHTML = '';
    viewEl.appendChild(table);
  }

  async function renderDetail(gameId) {
    const games = await loadGames();
    const g = games.find(x => x.gameId === gameId);
    countEl.textContent = '';

    if (!g) {
      viewEl.innerHTML = `<div class="xq-empty-state"><a href="#/">← 返回列表</a><p>对局不存在。</p></div>`;
      return;
    }

    const header = h(`
      <div class="xq-detail-header">
        <a href="#/">← 返回</a>
        <div class="xq-detail-meta">
          <div><b>${esc(opponentOf(g))}</b></div>
          <div class="xq-muted">${esc(fmtDate(g.startTime))} · ${g.moves.length} 步 · ${esc(resultOf(g))}</div>
          <div class="xq-muted">红方: ${esc(g.players?.red?.username || '—')} · 黑方: ${esc(g.players?.black?.username || '—')}</div>
        </div>
      </div>`);

    // Move list with evals, highlight big swings
    const moves = g.moves.slice().sort((a,b)=>a.i-b.i);
    // Normalize evals to red's perspective so we can spot swings
    const redCp = moves.map(m => {
      if (m.mate != null) return (m.turn === 'black' ? -m.mate : m.mate) > 0 ? 3000 : -3000;
      if (m.cp == null) return null;
      return m.turn === 'black' ? -m.cp : m.cp;
    });

    const list = h(`<ol class="xq-move-list"></ol>`);
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const prev = i > 0 ? moves[i-1] : null;
      const plain = m.uci && prev ? uciToPlain(m.uci, fenToBoard(prev.fen)) : (m.uci || '(起始局面)');
      const sc = scoreOf(m.cp, m.mate);
      // Swing vs previous: in red-perspective cp
      let swingClass = '';
      if (i > 0 && redCp[i] != null && redCp[i-1] != null) {
        const diff = Math.abs(redCp[i] - redCp[i-1]);
        if (diff >= 300) swingClass = 'xq-swing-big';
        else if (diff >= 100) swingClass = 'xq-swing-mid';
      }
      const li = h(`
        <li class="${swingClass}">
          <span class="xq-move-i">${m.i}</span>
          <span class="xq-move-side ${m.turn === 'red' ? 'red' : 'black'}">${m.turn === 'red' ? '红' : '黑'}</span>
          <span class="xq-move-text">${esc(plain)}</span>
          <span class="xq-move-score">${esc(sc)}</span>
        </li>`);
      list.appendChild(li);
    }

    const stub = h(`
      <div class="xq-ai-stub">
        <button id="xq-ai" disabled title="下一期实现">AI 复盘 (未实现)</button>
        <span class="xq-muted">棋盘回放 / 评分曲线 / AI 复盘将在下一期加入</span>
      </div>`);

    viewEl.innerHTML = '';
    viewEl.appendChild(header);
    viewEl.appendChild(list);
    viewEl.appendChild(stub);
  }

  // ---- Router ----------------------------------------------------------
  function route() {
    const hash = location.hash.slice(1); // drop '#'
    const m = hash.match(/^\/game\/(.+)$/);
    if (m) renderDetail(decodeURIComponent(m[1]));
    else renderList();
  }

  window.addEventListener('hashchange', route);
  document.getElementById('xq-refresh').addEventListener('click', route);
  document.getElementById('xq-clear').addEventListener('click', clearAll);
  route();
})();
