# Xiangqi Analyzer

play.xiangqi.com 的局面分析浮层。在右上角显示评分 + 引擎推荐前 3 步。

## 引擎

用 [fairy-stockfish-nnue.wasm](https://www.npmjs.com/package/fairy-stockfish-nnue.wasm) v1.1.11(GPL-3.0)。
该包是 Fairy-Stockfish 的 WebAssembly 编译,自带象棋(xiangqi)变体支持。
没用 Pikafish 是因为它没有现成 WASM 构建,自己编译需要 Emscripten + 处理 NNUE
+ SharedArrayBuffer 的麻烦。Fairy-Stockfish 在象棋上比 Pikafish 弱一些但够分析用。

### 多引擎架构

`offscreen.js` 顶部的 `ENGINES` 数组是引擎注册表,UI 浮层右上角的下拉框
按这份注册表渲染。当前注册了两个 Profile(同一份 binary、不同参数):

- `fairy-fast`:Fairy-Stockfish · 1.5s · 半数核心 · 64MB hash · NNUE
- `fairy-strong`:Fairy-Stockfish · 5s · 全核 · 512MB hash · NNUE
- `pikafish`:Pikafish (NNUE) · 4s · 全核 · 256MB · 比 Fairy 再强一档

NNUE 装载:引擎启动时 `loadNnue()` fetch 字节,`Module.FS.writeFile` 写到
MEMFS,再 `setoption name EvalFile` 让引擎加载。同一文件由 `nnueCache`
去重,多个 profile 共享一份内存。

Pikafish 是 [official-pikafish/Pikafish](https://github.com/official-pikafish/Pikafish)
的 WASM 编译产物,API(`addMessageListener`/`postMessage`/`FS`)和 Fairy 一致,
所以 EngineInstance 完全复用,不用做适配。注意 Pikafish 是专用象棋引擎,
**没有** `UCI_Variant` 选项(Fairy 才有)。

切换流程:UI 改下拉 → `localStorage` 持久化 → 若该我走则立刻用新引擎重分析。
引擎按需懒加载(第一次选才加载 WASM,之后常驻)。切换瞬间会 `stop` 旧引擎,
旧引擎残留的 `info` / `bestmove` 在 router 里被丢弃,不会污染新引擎的输出。

UCI 引擎本身无状态(每次 `position fen + go` 从头算),所以切引擎不会丢
"对话上下文"——只是丢掉旧引擎的置换表,而我们本来就不跨步复用 hash。

加新引擎(比如 Pikafish)= `ENGINES` 加一条 + 把文件丢进 `engine/`,
其它三个文件(background / content / html)零改动。

## 文件结构

```
xiangqi-analyzer/
├── manifest.json       MV3 清单,声明 COOP/COEP 让扩展页面 cross-origin isolated
├── background.js       Service Worker,管理 offscreen document 生命周期
├── offscreen.html      跨域隔离的引擎宿主页面
├── offscreen.js        引擎驱动:加载 WASM,解析 UCI,发结果
├── content-main.js     MAIN world:轮询 React Fiber 取 FEN
├── content-iso.js      ISOLATED world:浮层 UI + 消息桥接
├── overlay.css         浮层样式
└── engine/
    ├── stockfish.js                      Fairy-Stockfish 加载器 (vendored)
    ├── stockfish.wasm                    Fairy-Stockfish 二进制 (1.6MB)
    ├── stockfish.worker.js               Fairy-Stockfish pthread worker
    ├── xiangqi-c07e94a5c7cb.nnue         Fairy-Stockfish 象棋 NNUE (10.7MB)
    ├── pikafish.js                       Pikafish 加载器 (vendored)
    ├── pikafish.wasm                     Pikafish 二进制 (1.0MB)
    ├── pikafish.worker.js                Pikafish pthread worker
    └── pikafish.nnue                     Pikafish NN 网络 (51MB)
```

## 架构

```
play.xiangqi.com 页面
├── content-main.js  (MAIN world)     React Fiber → FEN
│       │ CustomEvent 'xq:fen'
│       ▼
├── content-iso.js   (ISOLATED)       浮层 UI + 桥接
│       │ chrome.runtime.sendMessage
│       ▼
   background.js     (Service Worker)
        │ chrome.runtime.sendMessage / chrome.tabs.sendMessage
        ▼
   offscreen.html / offscreen.js     ← 这里是 cross-origin isolated,
        │                              SharedArrayBuffer 可用
        ▼
   stockfish.js + WASM + pthread workers
```

为什么这么折腾:`play.xiangqi.com` 没设 COOP/COEP 响应头,页面里 `crossOriginIsolated`
是 false,所以 `new WebAssembly.Memory({shared: true})` 会失败。MV3 扩展可以在
manifest 里给自己的页面声明 COOP/COEP,offscreen document 因此能用 SAB,引擎跑得起来。

## 安装

1. Chrome 打开 `chrome://extensions/`
2. 右上角打开"开发者模式"
3. 点"加载已解压的扩展程序",选 `xiangqi-analyzer/` 目录
4. 打开 [play.xiangqi.com](https://play.xiangqi.com),进任意一局
5. 右上角应该出现 `XQ Analyzer` 浮层

第一次加载 WASM 大概 2-3 秒,状态栏显示 `loading… → idle/thinking…`。
有走子时自动重新分析,固定 1 秒思考时间。

## 浮层操作

- **拖拽**:点 header 拖动
- **引擎下拉**:切换分析引擎/profile,选择会持久化
- **⏸ / ▶**:暂停 / 恢复分析
- **─ / +**:折叠 / 展开

## 显示约定

- 评分**始终从红方视角**显示:`+0.50` 红方优 0.5 兵,`-1.20` 红方劣 1.2 兵。
- `M5` 表示 5 步杀(红方杀),`-M3` 表示 3 步被杀。
- `d 18 ✓` 表示完成深度 18 的搜索,无 ✓ 是中间结果。
- PV 走法用 UCI 表示法:`h2e2` = 棋子从 h2 移到 e2(file a-i,rank 0-9,
  rank 0 是红方底线)。

## 调试

- 浮层异常:`F12` 看 Console,找 `[XQ-Analyzer]` 和 `[XQ-Overlay]` 标签
- 引擎异常:`chrome://extensions/` → 扩展的 "service worker" 链接 →
  Console,找 `[XQ-BG]` 和 `[XQ-Engine]`
- offscreen 文档自己也有 console:`chrome://extensions/` → "Inspect views: offscreen.html"

## 已知限制

- 引擎深度比桌面版浅(WASM ~慢 2x,无原生 SIMD/AVX)
- React Fiber 走法依赖 `__reactFiber` 属性,前端框架升级可能要改提取逻辑
- 浮层用了 `z-index: 2147483647`,理论上一直在顶层

## 后续可加的功能

- [ ] 引擎建议在棋盘上画箭头(需要识别坐标系映射)
- [ ] 历史评分曲线(按步序记录每一步评分)
- [ ] UCI 走法 → 中文记谱(炮二平五 等)
