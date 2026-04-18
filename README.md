# Xiangqi Analyzer

play.xiangqi.com 的局面分析浮层。在右上角显示评分 + 引擎推荐前 3 步。

## 引擎

用 [fairy-stockfish-nnue.wasm](https://www.npmjs.com/package/fairy-stockfish-nnue.wasm) v1.1.11(GPL-3.0)。
该包是 Fairy-Stockfish 的 WebAssembly 编译,自带象棋(xiangqi)变体支持。
没用 Pikafish 是因为它没有现成 WASM 构建,自己编译需要 Emscripten + 处理 NNUE
+ SharedArrayBuffer 的麻烦。Fairy-Stockfish 在象棋上比 Pikafish 弱一些但够分析用。

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
    ├── stockfish.js          Fairy-Stockfish 加载器 (vendored)
    ├── stockfish.wasm        引擎二进制 (1.6MB)
    └── stockfish.worker.js   pthread worker
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

- 引擎用单线程 + 32MB 哈希,深度比桌面版浅
- 没集成 NNUE 神经网络文件,用 HCE 评估(还行,但不如 Pikafish 准)
- React Fiber 走法依赖 `__reactFiber` 属性,前端框架升级可能要改提取逻辑
- 浮层用了 `z-index: 2147483647`,理论上一直在顶层

## 后续可加的功能

- [ ] 引擎建议在棋盘上画箭头(需要识别坐标系映射)
- [ ] 历史评分曲线(按步序记录每一步评分)
- [ ] UCI 走法 → 中文记谱(炮二平五 等)
- [ ] 支持下载 NNUE 文件提升强度
- [ ] 替换为 Pikafish(等谁有时间编个 WASM 版)
