'use strict';

/* =========================================================
   StarNotes 原型 · 单文件交互逻辑
   依赖：无。存储：用户指定的本地文件夹（File System Access API）。

   模型：一个文件夹 = 一块画布 = 上层图里的一个节点。

     你选的库文件夹          ← 根画布，本身也是一块画布
     ├── 知识地图/           ← 子画布（可再套子画布，层数不限）
     │   ├── 双链与反链.md    ← 笔记，本层图里的叶子节点
     │   └── 图谱/
     └── 写作线索/

   任意一层 = 该文件夹下的「子文件夹（画布）+ .md（笔记）」，两种节点
   同层共存，可以互相连线。每一层各自有一份坐标
   （StarNotes.canvas.md）和一份关系表（StarNotes.graph.md），互不干扰：
   关系只在本画布内有效，画布之间则在上层图里连线。

   笔记文件本身是纯 Markdown，零元数据，可以单独发给别人。
   ========================================================= */

const $ = (s, r = document) => r.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const NW = 168;   // 节点宽（与 CSS 变量一致）
const NH = 88;    // 节点高（与 CSS 变量一致，改一个必须改另一个）
const PRESETS = ['属于', '前置知识', '对比', '引用', '相关', '延伸'];

const LAYOUT_FILE = 'StarNotes.canvas.md';
const GRAPH_FILE = 'StarNotes.graph.md';
/* 2026-11 项目改名（StarNote → StarNotes）。已经建好的库里，这两张表还叫旧名，
   所以读的时候按旧名兜底、写只用新名——老库打开一次就自然迁到新文件名，
   不会被判成"坐标全丢、节点未上板"。旧文件不删：里面是用户上一次的布局，
   删不删由他自己决定，我们只保证新文件优先。 */
const LEGACY_LAYOUT_FILE = 'StarNote.canvas.md';
const LEGACY_GRAPH_FILE = 'StarNote.graph.md';
const META_FILES = new Set(
  [LAYOUT_FILE, GRAPH_FILE, LEGACY_LAYOUT_FILE, LEGACY_GRAPH_FILE].map((s) => s.toLowerCase()),
);

/* 哪些 .md 不是笔记，而是我们自己的图数据文件。
   除了固定的两张表，还要认旧版（多画布时代）的 `<画布名>.canvas.md`：
   那些文件没有 H1，被当笔记载入就会在画布上冒出一个「主画布.canvas」节点。 */
const isMetaFile = (name) => META_FILES.has(name.toLowerCase()) || /\.(canvas|graph)\.md$/i.test(name);
const isLegacyLayout = (name) => /\.canvas\.md$/i.test(name) && !META_FILES.has(name.toLowerCase());

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  vault: null,          // 库根目录句柄
  dir: null,            // 当前层的目录句柄（= stack 最后一项的 dir）
  stack: [],            // 从库根到当前层的路径 [{name, dir}]，长度 ≥ 1
  nodes: new Map(),     // 当前层的节点：子画布（文件夹）+ 笔记（.md）
  adj: new Map(),
  layout: new Map(),    // 当前层坐标 name -> {x,y}
  view: { x: 0, y: 0, k: 1 },
  selected: null,       // 主选中（最后点的那一个），沿用旧语义：Enter 打开、边高亮
  selection: new Set(), // 多选：当前选中的所有 id（含 selected）。Ctrl/⌘+点击累加
  hovered: null,
  search: '',
  link: null,
  editing: null,
  hintBase: '',
  hoverTimer: null,
  hideTimer: null,
  layoutTimer: null,
  graphTimer: null,
  dirtyLayout: false,
  dirtyGraph: false,
};

/* 当前层是库根吗？（根画布没有上层） */
const atRoot = () => state.stack.length <= 1;
const pathNames = () => state.stack.map((s) => s.name);
const isSel = (id) => !!id && state.selection.has(id);
const isTyping = () => {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
};

const stage = $('#stage');
const viewport = $('#viewport');
const nodeLayer = $('#nodeLayer');
const edgeLayer = $('#edgeLayer');
const hovercard = $('#hovercard');
const ctxmenu = $('#ctxmenu');
const popover = $('#popover');

/* ============ 1. 笔记文件 ============
   笔记文件是纯 Markdown：第一行 # 标题，其余全是正文。
   关系、坐标这些图数据一律不写进笔记文件——这样才能单独发给别人。
   ==================================== */

function unquote(v) {
  if (/^".*"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"');
  return v;
}

// 这些键是我们自己的图数据，读出来用于迁移，但绝不写回笔记文件
const NOTE_FM_KEYS = new Set(['id', 'title', 'rel', 'pos']);

function splitNote(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const res = { prefix: '', id: '', title: '', body: src, rel: [] };

  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(src);
  let rest = src;
  if (fm) {
    rest = src.slice(fm[0].length);
    const keep = [];
    const rel = [];
    let dropping = false;
    let cur = null;
    for (const line of fm[1].split(/\r?\n/)) {
      const top = /^([A-Za-z_][\w-]*)[ \t]*:/.exec(line);
      if (top) {
        dropping = NOTE_FM_KEYS.has(top[1]);
        if (top[1] === 'rel') cur = null;
        if (top[1] === 'id') res.id = unquote(line.slice(line.indexOf(':') + 1).trim());
        if (!dropping) keep.push(line);
        continue;
      }
      if (dropping) {
        const item = /^\s*-\s*(.*)$/.exec(line);
        if (item) {
          cur = {};
          rel.push(cur);
          const kv = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(item[1]);
          if (kv) cur[kv[1]] = kv[2].trim();
        } else {
          const kv = /^\s*([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
          if (kv && cur) cur[kv[1]] = kv[2].trim();
        }
        continue;
      }
      keep.push(line);
    }
    res.rel = rel;
    // 用户自己写的键原样保留，我们的键丢弃
    res.prefix = keep.some((l) => l.trim())
      ? '---\n' + keep.join('\n').replace(/\s+$/, '') + '\n---\n'
      : '';
  }

  const lines = rest.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i] && /^#[ \t]+/.test(lines[i])) {
    res.title = lines[i].replace(/^#[ \t]+/, '').trim();
    i++;
  }
  res.body = lines.slice(i).join('\n').replace(/^\n+/, '');
  return res;
}

function serializeNote(n) {
  const body = String(n.body || '').replace(/^\n+/, '');
  let out = (n.prefix ? n.prefix + '\n' : '') + '# ' + (n.title || '未命名') + '\n';
  if (body) out += '\n' + body + (body.endsWith('\n') ? '' : '\n');
  return out;
}

/* ---- 关系表：每一层一张，写在当层目录里 ---- */

const GRAPH_HEAD = '---\ntype: starnote-graph\nversion: 1\n---\n\n';

function parseGraph(text) {
  const out = new Map();
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const h = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (h) { cur = h[1]; if (!out.has(cur)) out.set(cur, []); continue; }
    if (!cur) continue;
    const li = /^[ \t]*[-*][ \t]+(.+)$/.exec(line);
    if (!li) continue;
    const parts = li[1].split('|').map((s) => s.trim());
    const last = parts[parts.length - 1];
    let dir = 1;
    let type = '';
    if (last === '→' || last === '↔') {
      dir = last === '↔' ? 0 : 1;
      type = parts.length > 2 ? parts.slice(1, -1).join(' | ').trim() : '';
    } else {
      type = parts.length > 1 ? parts.slice(1).join(' | ').trim() : '';
    }
    if (parts[0]) out.get(cur).push({ to: parts[0], type, dir });
  }
  return out;
}

function serializeGraph(nodes) {
  const out = [GRAPH_HEAD];
  const keys = [...nodes.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
  for (const k of keys) {
    const n = nodes.get(k);
    if (!n || !n.links.length) continue;
    out.push('## ' + k);
    for (const l of n.links) {
      out.push('- ' + l.to + (l.type ? ' | ' + l.type : '') + ' | ' + (l.dir ? '→' : '↔'));
    }
    out.push('');
  }
  return out.join('\n');
}

/* ---- 坐标表：每一层一张 ---- */

function parseLayout(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(.+?)\s+(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line);
    if (m) out.set(m[1].trim(), { x: +m[2], y: +m[3] });
  }
  return out;
}

function serializeLayout(layout) {
  const out = ['---', 'type: starnote-canvas', 'version: 2', '---', ''];
  for (const k of [...layout.keys()].sort((a, b) => a.localeCompare(b, 'zh'))) {
    const p = layout.get(k);
    out.push('- ' + k + ' ' + Math.round(p.x) + ' ' + Math.round(p.y));
  }
  return out.join('\n') + '\n';
}

/* ---- Markdown 渲染 ---- */

function inlineMd(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">$1</span>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderMd(src) {
  const lines = String(src || '').split(/\r?\n/);
  let out = '', list = null, code = false, buf = [];
  const closeList = () => { if (list) { out += '</' + list + '>'; list = null; } };
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (code) { out += '<pre><code>' + esc(buf.join('\n')) + '</code></pre>'; buf = []; code = false; }
      else { closeList(); code = true; }
      continue;
    }
    if (code) { buf.push(line); continue; }
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { closeList(); const h = m[1].length; out += `<h${h}>${inlineMd(m[2])}</h${h}>`; continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { closeList(); out += '<hr>'; continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) { closeList(); out += `<blockquote>${inlineMd(m[1])}</blockquote>`; continue; }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { if (list !== 'ul') { closeList(); out += '<ul>'; list = 'ul'; } out += `<li>${inlineMd(m[1])}</li>`; continue; }
    if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) { if (list !== 'ol') { closeList(); out += '<ol>'; list = 'ol'; } out += `<li>${inlineMd(m[1])}</li>`; continue; }
    closeList();
    out += `<p>${inlineMd(line)}</p>`;
  }
  if (code) out += '<pre><code>' + esc(buf.join('\n')) + '</code></pre>';
  closeList();
  return out;
}

function summaryOf(n, len = 110) {
  const t = String(n.body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, len) + (t.length > len ? '…' : '');
}

function ago(ts) {
  if (!ts) return '未记录';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.round(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.round(d / 3600e3) + ' 小时前';
  return Math.round(d / 86400e3) + ' 天前';
}

/* ============ 2. 图数据辅助 ============ */

const isVisible = (n) => !!n.pos;
const visibleNodes = () => [...state.nodes.values()].filter(isVisible);
const isCanvasNode = (n) => n.kind === 'canvas';

/* 卡片第二行要显示的「真名」。
   笔记 → `x.md`：标题取自正文 H1，而落盘时非法字符会被洗成 -、重名的第二篇会带 (2)、
   也可能是别人放进来的文件，两个名字不保证一样，所以真名必须露出来。
   画布 → 空：名字就是文件夹名，和标题永远相同，再写一遍是重复（样式里 :empty 会收掉这行）。 */
function fileNameOf(n) {
  if (isCanvasNode(n)) return '';
  return n.file || n.id || '未保存';
}

function buildAdj() {
  const adj = new Map();
  for (const n of state.nodes.values()) adj.set(n.id, new Set());
  for (const n of state.nodes.values()) {
    for (const l of n.links) {
      if (!state.nodes.has(l.to) || l.to === n.id) continue;
      adj.get(n.id).add(l.to);
      adj.get(l.to)?.add(n.id);
    }
  }
  state.adj = adj;
}

function neighbors(n) {
  const set = state.adj.get(n.id);
  if (!set) return [];
  const out = [];
  for (const id of set) {
    const m = state.nodes.get(id);
    if (m) out.push(m);
  }
  return out;
}

const degree = (n) => (state.adj.get(n.id)?.size || 0);
const hiddenNeighbors = (n) => neighbors(n).filter((m) => !isVisible(m));

function dedupeLinks(n) {
  const seen = new Set();
  return n.links.filter((l) => {
    const k = l.to + '|' + (l.type || '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ============ 3. 层级导航 ============
   每一层 = 一个文件夹。层里的节点 = 子文件夹（子画布）+ .md（笔记）。
   换层 = 先把当层改动落盘，再读新一层的目录。
   路径存在 state.stack 里，面包屑就是它。
   ==================================== */

function defaultPos() {
  const r = stage.getBoundingClientRect();
  return { x: (r.width / 2 - state.view.x) / state.view.k, y: (r.height / 2 - state.view.y) / state.view.k };
}

/* ---------- 占位与空位 ----------
   所有「两个节点算不算打架」的判断都走同一套尺寸：
   中心横向差 < MIN_DX 且 纵向差 < MIN_DY 就算重叠（即两节点之间留 NODE_GAP 的缝）。 */
const NODE_GAP = 26;
const MIN_DX = NW + NODE_GAP;
const MIN_DY = NH + NODE_GAP;
const SPOT_DX = NW + 40;                               // 找空位时横向一格
const SPOT_DY = NH + 36;                               // 纵向一格

/* 方位角，正右为 0，顺时针递增（屏幕 y 向下，atan2 正好是这个方向） */
const ang = (c) => (Math.atan2(c[1], c[0]) + Math.PI * 2) % (Math.PI * 2);

/* 当前这一层已经上板的坐标 */
function placements() {
  const m = new Map();
  for (const n of state.nodes.values()) if (n.pos) m.set(n.id, n.pos);
  return m;
}

function spotTaken(x, y, layout, skip) {
  for (const [id, p] of layout) {
    if (id === skip) continue;
    if (Math.abs(p.x - x) < MIN_DX && Math.abs(p.y - y) < MIN_DY) return true;
  }
  return false;
}

/* 从 prefer 这个点起，找最近的空位。
   优先用传入的坐标（双击的那一点）；被占了就以它为中心一圈圈往外找。
   不这样做的话，连点两次「新建」得到的是两个中心完全重合的节点，上面的把下面的整个盖住。 */
function freePos(prefer, layout = placements(), skip) {
  const p = prefer || defaultPos();
  const x0 = Math.round(p.x), y0 = Math.round(p.y);
  if (!layout.size || !spotTaken(x0, y0, layout, skip)) return { x: x0, y: y0 };

  // 由内向外一圈圈找，同一圈里按方位排：从正右起顺时针（右下、正下…）。
  // 于是连续新建的节点会绕着起点顺时针铺开，既紧凑又不会一路向右跑出屏幕。
  for (let ring = 1; ring <= 40; ring++) {
    const cands = [];
    for (let i = -ring; i <= ring; i++) {
      cands.push([i, -ring], [i, ring]);
      if (i > -ring && i < ring) cands.push([-ring, i], [ring, i]);
    }
    cands.sort((a, b) => ang(a) - ang(b));
    for (const [dx, dy] of cands) {
      const x = x0 + dx * SPOT_DX, y = y0 + dy * SPOT_DY;
      if (!spotTaken(x, y, layout, skip)) return { x, y };
    }
  }
  return { x: x0, y: y0 };
}

/* 给「移进某个画布」的节点在那边找个落点：以那边已有节点的重心为起点 */
function freeSpotIn(layout) {
  if (!layout.size) return { x: 900, y: 640 };
  let sx = 0, sy = 0;
  for (const p of layout.values()) { sx += p.x; sy += p.y; }
  return freePos({ x: sx / layout.size, y: sy / layout.size }, layout);
}


/* ---------- 落地互斥：松开鼠标时，如果压在别的节点上，把自己弹开 ----------
   拖动过程中不碰任何别的节点（否则一路上会把别人的布局推乱，用户根本没想动它们）。
   只在落地的这一刻判定：只要和谁相交，就沿「拖动方向」的反向退出去，
   像撞到墙上弹回来；没有方向信息时就沿重叠更浅的那个轴退，位移最小。 */

function overlapOf(a, b) {
  const ox = MIN_DX - Math.abs(b.pos.x - a.pos.x);
  const oy = MIN_DY - Math.abs(b.pos.y - a.pos.y);
  if (ox <= 0 || oy <= 0) return null;   // 已经分开了
  return { ox, oy };
}

/* 把 n 挪到不和任何节点相交的位置，改动只落在 n 身上；返回是否挪过 */
function bounceOut(n, mv) {
  let moved = false;
  for (let i = 0; i < 12; i++) {
    let other = null, o = null;
    for (const m of state.nodes.values()) {
      if (m === n || !m.pos) continue;
      o = overlapOf(n, m);
      if (o) { other = m; break; }
    }
    if (!o) break;
    const ax = Math.abs(mv?.x || 0), ay = Math.abs(mv?.y || 0);
    const useX = ax > ay + 0.5 ? true : ay > ax + 0.5 ? false : o.ox < o.oy;
    // 退到刚好贴边：横向留 MIN_DX、纵向留 MIN_DY。
    // 完全压在对方身上时没有「谁在左谁在右」，就按拖动方向的反向弹回，像撞墙
    if (useX) {
      const d = n.pos.x - other.pos.x;
      const s = Math.abs(d) > 0.5 ? Math.sign(d) : (-Math.sign(mv?.x || 0) || 1);
      n.pos.x = other.pos.x + s * MIN_DX;
    } else {
      const d = n.pos.y - other.pos.y;
      const s = Math.abs(d) > 0.5 ? Math.sign(d) : (-Math.sign(mv?.y || 0) || 1);
      n.pos.y = other.pos.y + s * MIN_DY;
    }
    moved = true;
  }
  return moved;
}

/* 落点上压着谁？只认「覆盖」（中心距小于节点尺寸），刚好贴边不算。
   笔记优先——压在笔记上要弹开；只有压的是画布才当作「移入」。 */
function dropHit(n) {
  let canvas = null, best = Infinity;
  for (const m of state.nodes.values()) {
    if (m === n || !m.pos) continue;
    const dx = Math.abs(m.pos.x - n.pos.x), dy = Math.abs(m.pos.y - n.pos.y);
    if (dx >= NW || dy >= NH) continue;
    if (!isCanvasNode(m)) return m;
    if (dx + dy < best) { best = dx + dy; canvas = m; }
  }
  return canvas;
}

/* 拖动时落在哪个面包屑上？返回层下标，没落在上面返回 -1。
   用矩形命中而不是元素命中：拖动期间指针被 stage 捕获，
   elementFromPoint 也能用，但矩形比对在 jsdom 里同样能测。 */
function crumbHit(x, y) {
  for (const b of crumbEls()) {
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height) continue;             // 没布局（测试环境）就跳过
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return Number(b.dataset.depth);
  }
  return -1;
}

function crumbEls() {
  const el = $('#crumbs');
  if (!el || !el.querySelectorAll) return [];
  return [...el.querySelectorAll('.crumb.link')];
}

/* 高亮「松手会移出到这一层」的那一格 */
function markCrumbDrop(depth) {
  for (const b of crumbEls()) b.classList.toggle('drop-out', Number(b.dataset.depth) === depth);
}

function clearCrumbDrop() {
  markCrumbDrop(-1);
  setCrumbsDroppable(false);
}

/* 让面包屑在拖动时显形：祖先层能接住节点，这件事只有拖起来才该提示 */
function setCrumbsDroppable(on) {
  const el = $('#crumbs');
  if (el) el.classList.toggle('droppable', !!on);
}

/* 目标画布里取一个不重名的文件名，避免覆盖已有笔记 */
async function freeNameIn(dir, name) {
  if ((await readText(dir, name)) === null) return name;
  const base = name.replace(/\.md$/i, '');
  for (let i = 2; i < 100; i++) {
    const cand = base + ' (' + i + ').md';
    if ((await readText(dir, cand)) === null) return cand;
  }
  return base + ' (' + Date.now() + ').md';
}

/* 文件夹版的重名规避：画布节点的名字就是文件夹名，按文件探测会漏掉同名目录 */
async function freeDirNameIn(dir, name) {
  const taken = async (n) => {
    try { await dir.getDirectoryHandle(n); return true; } catch (e) { /* 没有同名目录 */ }
    try { await dir.getFileHandle(n); return true; } catch (e) { /* 也没有同名文件 */ }
    return false;
  };
  if (!(await taken(name))) return name;
  for (let i = 2; i < 100; i++) {
    const cand = name + ' (' + i + ')';
    if (!(await taken(cand))) return cand;
  }
  return name + ' (' + Date.now() + ')';
}

/* 把节点搬进目标画布文件夹：先搬文件，再从本层摘掉它的坐标与关系 */
async function moveInto(n, target) {
  const srcName = n.file || n.id;
  const title = n.title;
  let dstDir;
  try {
    dstDir = await state.dir.getDirectoryHandle(target.id);
  } catch (e) {
    flash('找不到画布「' + target.title + '」');
    return;
  }

  let movedName = srcName;
  try {
    if (isCanvasNode(n)) {
      // 子画布：整个文件夹递归复制；浏览器没有「移动目录」
      const src = await state.dir.getDirectoryHandle(srcName);
      const dst = await dstDir.getDirectoryHandle(srcName, { create: true });
      const r = await copyDirInto(src, dst);
      if (r.dst < r.src) throw new Error('只复制了 ' + r.dst + '/' + r.src + ' 项');
      await state.dir.removeEntry(srcName, { recursive: true });
    } else {
      const text = await readText(state.dir, srcName);
      if (text === null) throw new Error('读不到 ' + srcName);
      movedName = await freeNameIn(dstDir, srcName);
      await writeTextTo(dstDir, movedName, text);
      await state.dir.removeEntry(srcName);
    }
  } catch (e) {
    flash('移入「' + target.title + '」失败：' + e.message);
    return;
  }

  // 在目标画布里给它一个落点，否则进去以后是「未上板」，找不着
  const innerText = await readMeta(dstDir, LAYOUT_FILE, LEGACY_LAYOUT_FILE);
  const inner = innerText ? parseLayout(innerText) : new Map();
  inner.set(movedName, freeSpotIn(inner));
  await writeLayoutTo(dstDir, inner);

  if (state.editing === n) { state.editing = null; $('#editor').classList.remove('open'); }
  removeNodeRefs(n);                 // 本层的关系、坐标、DOM 一起清掉
  target._peek = null;               // hover 卡的缓存作废（里面多了一样东西）
  target._peekP = null;
  touchLayout();
  touchGraph();
  await flushWrites();               // 搬完立刻落盘，别等防抖，免得刚关掉浏览器就丢
  renderAll();
  renderCrumbs();
  flash('已把「' + title + '」移入画布「' + target.title + '」');
}

/* 把节点移出到上面某一层（拖到面包屑上）—— moveInto 的反方向。
   depth 是面包屑下标，只会是「祖先」，不会是自己这一层（当前层那格不是链接）。
   搬完跳过去并选中它：不然拖出去以后就不知道东西去哪了。 */
async function moveOut(n, depth) {
  const target = state.stack[depth];
  if (!target || depth >= state.stack.length - 1) return;

  const srcName = n.file || n.id;
  const title = n.title;
  const canvas = isCanvasNode(n);
  const edges = degree(n);           // 这些关联只在这一层有意义，搬走就断
  let movedName = srcName;

  try {
    if (canvas) {
      // 浏览器没有「移动目录」：先递归复制，核对项目数再删源目录
      const src = await state.dir.getDirectoryHandle(srcName);
      movedName = await freeDirNameIn(target.dir, srcName);
      const dst = await target.dir.getDirectoryHandle(movedName, { create: true });
      const r = await copyDirInto(src, dst);
      if (r.dst < r.src) throw new Error('只复制了 ' + r.dst + '/' + r.src + ' 项');
      await state.dir.removeEntry(srcName, { recursive: true });
    } else {
      const text = await readText(state.dir, srcName);
      if (text === null) throw new Error('读不到 ' + srcName);
      movedName = await freeNameIn(target.dir, srcName);
      await writeTextTo(target.dir, movedName, text);
      await state.dir.removeEntry(srcName);
    }
  } catch (e) {
    flash('移出到「' + target.name + '」失败：' + e.message);
    renderAll();                     // 拖动改过内存坐标，失败就退回盘上的位置
    return;
  }

  // 在那一层给它一个落点，否则跳过去是「未上板」，找不着
  const innerText = await readMeta(target.dir, LAYOUT_FILE, LEGACY_LAYOUT_FILE);
  const inner = innerText ? parseLayout(innerText) : new Map();
  inner.set(movedName, freeSpotIn(inner));
  await writeLayoutTo(target.dir, inner);

  if (state.editing === n) { state.editing = null; $('#editor').classList.remove('open'); }
  removeNodeRefs(n);                 // 本层关系、坐标、DOM 一起清掉
  touchLayout();
  touchGraph();
  await flushWrites();               // 搬完立刻落盘，别等防抖

  await goTo(depth);                 // loadLevel 里会 fitView，所以下面再判断可见性
  const back = [...state.nodes.values()].find((m) => (m.file || m.id) === movedName);
  if (back) {
    select(back.id);
    const r = stage.getBoundingClientRect();
    const sx = (back.pos?.x || 0) * state.view.k + state.view.x;
    const sy = (back.pos?.y || 0) * state.view.k + state.view.y;
    // 落点在屏幕外才跳过去：本来就看得到的话，别把视野拽走
    if (sx < 60 || sy < 60 || sx > r.width - 60 || sy > r.height - 60) focusOn(back);
  }
  flash('已把「' + title + '」移出到「' + target.name + '」' +
    (edges ? '（原来那层的 ' + edges + ' 条关联已清除）' : ''));
}

function uniqueDirName(base) {
  const name = String(base || '新画布').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || '新画布';
  const used = new Set([...state.nodes.values()].filter(isCanvasNode).map((n) => n.id));
  if (!used.has(name)) return name;
  let i = 2;
  while (used.has(name + ' (' + i + ')')) i++;
  return name + ' (' + i + ')';
}

async function writeTextTo(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

async function readText(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).text();
  } catch (e) {
    return null;
  }
}

/* 读两张程序表：先认新名，没有就退回改名前的旧名。
   只在这一层做兜底，写、合并、同步全都只认新名。 */
async function readMeta(dir, name, legacyName) {
  const text = await readText(dir, name);
  if (text !== null) return text;
  return readText(dir, legacyName);
}

/* 只问"在不在"，不读内容（迁移判断用，省一次整文件读取） */
async function hasFile(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    return false;
  }
}

/* 画布节点要显示「里面有啥」，进画布前先读一眼：笔记清单 + 子画布 + 坐标 + 边 */
async function peekCanvas(n) {
  if (n._peek) return n._peek;
  if (n._peekP) return n._peekP;
  n._peekP = (async () => {
    const res = { notes: [], canvases: [], placements: new Map(), edges: [], edgeCount: 0 };
    try {
      const dir = await state.dir.getDirectoryHandle(n.id);
      const legacy = [];
      for await (const [name, h] of dir.entries()) {
        if (!name || name.startsWith('.')) continue;
        if (h.kind === 'directory') res.canvases.push(name);
        else if (/\.md$/i.test(name)) { if (isLegacyLayout(name)) legacy.push(name); else if (!isMetaFile(name)) res.notes.push(name); }
      }
      res.notes.sort((a, b) => a.localeCompare(b, 'zh'));
      res.canvases.sort((a, b) => a.localeCompare(b, 'zh'));
      let lay = await readMeta(dir, LAYOUT_FILE, LEGACY_LAYOUT_FILE);
      if (!lay && legacy.length) lay = await readText(dir, legacy[0]);   // 还没迁移的旧画布
      if (lay) res.placements = parseLayout(lay);
      const gtext = await readMeta(dir, GRAPH_FILE, LEGACY_GRAPH_FILE);
      if (gtext) {
        for (const [from, list] of parseGraph(gtext)) {
          for (const l of list) {
            res.edges.push({ from, to: l.to });
            res.edgeCount++;
          }
        }
      }
    } catch (e) { /* 文件夹可能已经被删掉了 */ }
    n._peek = res;
    n._peekP = null;
    return res;
  })();
  return n._peekP;
}

async function warmPeek() {
  const list = [...state.nodes.values()].filter(isCanvasNode);
  if (!list.length) return;
  await Promise.all(list.map(peekCanvas));
  for (const n of list) paintNode(n);
}

/* ============ 4. 写盘 ============ */

async function writeLayoutTo(dir, layout) {
  if (!dir) return false;
  try {
    await writeTextTo(dir, LAYOUT_FILE, serializeLayout(layout));
    return true;
  } catch (err) {
    console.error(err);
    flash('坐标保存失败：' + err.message);
    return false;
  }
}

async function writeGraphTo(dir, nodes) {
  if (!dir) return false;
  try {
    await writeTextTo(dir, GRAPH_FILE, serializeGraph(nodes));
    return true;
  } catch (err) {
    console.error(err);
    flash('关系表保存失败：' + err.message);
    return false;
  }
}

function snapshotLayout() {
  const p = new Map();
  for (const n of state.nodes.values()) if (n.pos) p.set(n.id, { x: n.pos.x, y: n.pos.y });
  state.layout = p;
}

function touchLayout() {
  snapshotLayout();
  state.dirtyLayout = true;
  const dir = state.dir;
  clearTimeout(state.layoutTimer);
  state.layoutTimer = setTimeout(() => {
    if (dir !== state.dir) return;   // 已经换层，交给 flushWrites
    state.dirtyLayout = false;
    writeLayoutTo(dir, state.layout);
  }, 500);
}

function touchGraph() {
  state.dirtyGraph = true;
  const dir = state.dir;
  const nodes = state.nodes;
  clearTimeout(state.graphTimer);
  state.graphTimer = setTimeout(() => {
    if (dir !== state.dir) return;
    state.dirtyGraph = false;
    writeGraphTo(dir, nodes);
  }, 400);
}

async function flushWrites() {
  clearTimeout(state.layoutTimer);
  clearTimeout(state.graphTimer);
  if (!state.dir) return;
  const dl = state.dirtyLayout, dg = state.dirtyGraph;
  state.dirtyLayout = false;
  state.dirtyGraph = false;
  if (dl) await writeLayoutTo(state.dir, state.layout);
  if (dg) await writeGraphTo(state.dir, state.nodes);
}

/* ============ 5. 渲染 ============ */

function renderAll() {
  buildAdj();
  for (const n of state.nodes.values()) paintNode(n);
  renderEdges();
  renderStats();
  applyView();
  renderEmpty();
  renderSelBar();
}

function renderCrumbs() {
  const el = $('#crumbs');
  if (!el) return;
  const stack = state.stack;
  if (!stack.length) { el.innerHTML = ''; return; }
  const parts = [];
  stack.forEach((s, i) => {
    const last = i === stack.length - 1;
    const icon = i === 0 ? '▦' : '▣';
    const num = last && cntLabel() ? '<span class="cnum">' + cntLabel() + '</span>' : '';
    if (last) {
      parts.push('<span class="crumb cur" title="' + esc(s.name) + '"><span class="cico' + (i ? ' fld' : '') + '">' + icon + '</span><span class="cnm">' + esc(s.name) + '</span>' + num + '</span>');
    } else {
      parts.push('<button class="crumb link" data-depth="' + i + '" title="回到「' + esc(s.name) + '」"><span class="cico' + (i ? ' fld' : '') + '">' + icon + '</span><span class="cnm">' + esc(s.name) + '</span></button>');
      parts.push('<span class="csep">›</span>');
    }
  });
  el.innerHTML = parts.join('');
  // 层级深时把面包屑滚到最右，让当前层始终可见
  el.scrollLeft = el.scrollWidth;
}

function cntLabel() {
  let c = 0, m = 0;
  for (const n of state.nodes.values()) isCanvasNode(n) ? c++ : m++;
  if (c && m) return c + ' 画布 · ' + m + ' 篇';
  if (c) return c + ' 画布';
  if (m) return m + ' 篇';
  return '';
}

function renderHint() {
  const h = $('.hint');
  if (!h) return;
  state.hintBase = '双击节点打开 · 点 +N 展开相邻 · Ctrl+点击多选 · Del 删除 · 双击空白处新建';
  h.textContent = state.hintBase;
}

function updateToolbar() {
  const s = $('#search');
  if (s) s.placeholder = '搜索本层节点…';
}

function renderEmpty() {
  const es = $('#emptyState');
  if (!es) return;
  const empty = !!state.vault && state.nodes.size === 0;
  es.classList.toggle('show', empty);
  if (!empty) return;
  const here = pathNames().join(' / ');
  $('#esTitle').textContent = atRoot() ? '这个库还是空的' : '这块画布还是空的';
  $('#esDesc').innerHTML =
    '双击空白处新建笔记，或点顶栏「＋ 画布」建一块子画布。<br>' +
    '笔记会写进 <b>' + esc(here) + '</b>，一篇一个 <code>.md</code>；子画布是这个文件夹里的子文件夹。';
}

function nodeEl(n) {
  if (n.el) return n.el;
  const el = document.createElement('div');
  el.className = 'node' + (n.kind === 'canvas' ? ' is-canvas' : '');
  el.dataset.id = n.id;
  el.innerHTML = '<div class="node-title"></div><div class="node-file"></div><div class="node-meta"></div><div class="handle" title="拖拽到另一个节点建立关联"></div>';
  el.addEventListener('mouseenter', () => {
    if (state.link) return;
    clearTimeout(state.hoverTimer);
    state.hoverTimer = setTimeout(() => showHover(n, el), 320);
  });
  el.addEventListener('mouseleave', (ev) => {
    clearTimeout(state.hoverTimer);
    if (ev.relatedTarget && hovercard.contains(ev.relatedTarget)) return;
    scheduleHideHover();
  });
  nodeLayer.appendChild(el);
  n.el = el;
  return el;
}

function paintNode(n) {
  const el = nodeEl(n);
  const vis = isVisible(n);
  el.style.display = vis ? '' : 'none';
  if (!vis) return;
  el.style.left = (n.pos.x - NW / 2) + 'px';
  el.style.top = (n.pos.y - NH / 2) + 'px';
  const on = isSel(n.id);
  el.classList.toggle('selected', on);
  el.classList.toggle('multi', on && state.selection.size > 1);
  const q = state.search.trim().toLowerCase();
  const file = fileNameOf(n);
  // 文件名也进搜索词：按「(2)」或者被清理过非法字符的那种名字，只有磁盘上才看得出区别
  const hay = n.title + ' ' + file + ' ' + (n.body || '');
  el.classList.toggle('dim', !!q && !hay.toLowerCase().includes(q));
  el.querySelector('.node-title').textContent = n.title || '未命名';
  el.querySelector('.node-file').textContent = file;

  const hidden = hiddenNeighbors(n).length;
  const badge = hidden ? '<span class="node-more">+' + hidden + '</span>' : '';
  if (isCanvasNode(n)) {
    let cnt = '画布';
    if (n._peek) {
      const a = n._peek.notes.length, b = n._peek.canvases.length;
      cnt = [a ? a + ' 篇' : '', b ? b + ' 画布' : ''].filter(Boolean).join(' · ') || '空画布';
    } else if (n._peekP) cnt = '读取中';
    el.querySelector('.node-meta').innerHTML =
      '<span class="ctag">画布</span><span>' + cnt + '</span><span>' + degree(n) + ' 关联</span>' + badge;
  } else {
    el.querySelector('.node-meta').innerHTML =
      '<span>' + degree(n) + ' 关联</span>' + badge;
  }
}

function anchor(from, to) {
  const dx = to.pos.x - from.pos.x;
  const dy = to.pos.y - from.pos.y;
  const adx = Math.abs(dx) || 1e-4;
  const ady = Math.abs(dy) || 1e-4;
  const t = Math.min((NW / 2 + 6) / adx, (NH / 2 + 6) / ady);
  return { x: from.pos.x + dx * t, y: from.pos.y + dy * t };
}

function renderEdges() {
  edgeLayer.textContent = '';
  const vis = visibleNodes();
  const seen = new Set();
  for (const n of vis) {
    n.links.forEach((l, idx) => {
      const t = state.nodes.get(l.to);
      if (!t || !isVisible(t)) return;
      const key = [n.id, t.id].sort().join('~') + '~' + (l.type || '');
      if (seen.has(key)) return;
      seen.add(key);
      edgeLayer.appendChild(edgeEl(n, t, l, idx));
    });
  }
}

function edgeEl(a, b, l, idx) {
  const s = anchor(a, b);
  const e = anchor(b, a);
  const dx = e.x - s.x, dy = e.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(26, len * 0.09);
  const cx = (s.x + e.x) / 2 - (dy / len) * off;
  const cy = (s.y + e.y) / 2 + (dx / len) * off;

  const hot = isSel(a.id) || isSel(b.id) || state.hovered === a.id || state.hovered === b.id;

  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('class', 'wire' + (hot ? ' hot' : ''));
  p.setAttribute('d', `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${e.x.toFixed(1)} ${e.y.toFixed(1)}`);
  p.dataset.src = a.id;
  p.dataset.idx = idx;
  if (l.dir) p.setAttribute('marker-end', hot ? 'url(#arrow-hot)' : 'url(#arrow)');

  if (!hot || !l.type) return p;

  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('pointer-events', 'none');
  const mx = s.x * 0.25 + cx * 0.5 + e.x * 0.25;
  const my = s.y * 0.25 + cy * 0.5 + e.y * 0.25;
  const w = l.type.length * 11 + 14;
  const rect = document.createElementNS(SVGNS, 'rect');
  rect.setAttribute('class', 'wire-label-bg');
  rect.setAttribute('x', mx - w / 2);
  rect.setAttribute('y', my - 9);
  rect.setAttribute('width', w);
  rect.setAttribute('height', 17);
  rect.setAttribute('rx', 8.5);

  const text = document.createElementNS(SVGNS, 'text');
  text.setAttribute('class', 'wire-label');
  text.setAttribute('x', mx);
  text.setAttribute('y', my + 2);
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'middle');
  text.setAttribute('font-size', '11');
  text.textContent = l.type;

  const wrap = document.createElementNS(SVGNS, 'g');
  wrap.appendChild(p);
  g.appendChild(rect);
  g.appendChild(text);
  wrap.appendChild(g);
  return wrap;
}

function renderStats() {
  const vis = visibleNodes();
  let c = 0, m = 0;
  for (const n of vis) isCanvasNode(n) ? c++ : m++;
  $('#statNodes').textContent = c && m ? c + ' 画布 · ' + m + ' 篇' : (c ? c + ' 画布' : m + ' 篇');
  let links = 0;
  const seen = new Set();
  for (const n of vis) {
    for (const l of n.links) {
      const t = state.nodes.get(l.to);
      if (!t || !isVisible(t)) continue;
      const k = [n.id, t.id].sort().join('~') + '~' + (l.type || '');
      if (seen.has(k)) continue;
      seen.add(k);
      links++;
    }
  }
  $('#statLinks').textContent = links + ' 关联';

  const hidden = [...state.nodes.values()].filter((n) => !isVisible(n)).length;
  const chip = $('#hiddenChip');
  chip.classList.toggle('show', hidden > 0);
  if (hidden > 0) chip.textContent = hidden + ' 个节点未上板 · 全部展开';
  chip.title = '这些节点在文件夹里，但当前没有摆放到这块画布上';
  chip.onclick = () => revealAll();
}

/* ============ 6. 视图变换 ============ */

function applyView() {
  const v = state.view;
  viewport.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
  $('#statZoom').textContent = Math.round(v.k * 100) + '%';
}

function toWorld(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return { x: (clientX - r.left - state.view.x) / state.view.k, y: (clientY - r.top - state.view.y) / state.view.k };
}

function fitView() {
  const vis = visibleNodes();
  if (!vis.length) return;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of vis) {
    x1 = Math.min(x1, n.pos.x - NW / 2); x2 = Math.max(x2, n.pos.x + NW / 2);
    y1 = Math.min(y1, n.pos.y - NH / 2); y2 = Math.max(y2, n.pos.y + NH / 2);
  }
  const r = stage.getBoundingClientRect();
  const pad = 110;
  const k = clamp(Math.min((r.width - pad * 2) / Math.max(x2 - x1, 1), (r.height - pad * 2) / Math.max(y2 - y1, 1)), 0.25, 1.1);
  state.view = { k, x: r.width / 2 - ((x1 + x2) / 2) * k, y: r.height / 2 - ((y1 + y2) / 2) * k };
  applyView();
}

function focusOn(n) {
  const r = stage.getBoundingClientRect();
  state.view.x = r.width / 2 - n.pos.x * state.view.k;
  state.view.y = r.height / 2 - n.pos.y * state.view.k;
  applyView();
}

/* ============ 7. 展开 / 收起 ============ */

function reveal(m, parent, i, total) {
  if (!m.pos) {
    const seed = (parent.id.length * 7 + (parent.id.charCodeAt(0) || 3)) % 7;
    const angle = -Math.PI / 2 + (i / Math.max(total, 1)) * Math.PI * 2 + seed * 0.12;
    const dist = 250 + (i % 3) * 45;
    m.pos = { x: parent.pos.x + Math.cos(angle) * dist, y: parent.pos.y + Math.sin(angle) * dist };
  }
  m.revealedBy.add(parent.id);
}

function toggleExpand(n) {
  const hidden = hiddenNeighbors(n);
  if (!hidden.length) return;
  hidden.forEach((m, i) => reveal(m, n, i, hidden.length));
  renderAll();
  touchLayout();
}

function collapseFrom(n) {
  for (const m of neighbors(n)) {
    if (!m.revealedBy.has(n.id)) continue;
    m.revealedBy.delete(n.id);
    if (m.revealedBy.size === 0) m.pos = null;
  }
}

function revealAll() {
  const hidden = [...state.nodes.values()].filter((n) => !isVisible(n));
  let i = 0;
  for (const n of hidden) {
    const angle = i * 2.39996;
    const r = 90 * Math.sqrt(i + 1) + 160;
    n.pos = { x: 900 + Math.cos(angle) * r, y: 640 + Math.sin(angle) * r };
    i++;
  }
  renderAll();
  fitView();
  touchLayout();
}

/* ============ 8. 选中 / 悬浮预览 / 菜单 ============ */

/* 单选：清掉多选，只剩这一项（null = 全部取消） */
function select(id) {
  const next = id && state.nodes.has(id) ? id : null;
  state.selection.clear();
  if (next) state.selection.add(next);
  state.selected = next;
  renderAll();
}

/* Ctrl/⌘ + 左键：把这一项加进选择集合，或从中拿掉 */
function toggleSelect(id) {
  if (!id || !state.nodes.has(id)) return;
  if (state.selection.has(id)) {
    state.selection.delete(id);
    if (state.selected === id) {
      const rest = [...state.selection];
      state.selected = rest.length ? rest[rest.length - 1] : null;
    }
  } else {
    state.selection.add(id);
    state.selected = id;   // 新加进来的成为主选中
  }
  renderAll();
}

function selectAllVisible() {
  const ids = visibleNodes().map((n) => n.id);
  if (!ids.length) return;
  state.selection = new Set(ids);
  state.selected = ids[ids.length - 1];
  renderAll();
  flash('已选中本层 ' + ids.length + ' 个节点');
}

/* 底部那条「已选 N 项」的浮条，只在多选时出现 */
function renderSelBar() {
  const bar = $('#selBar');
  if (!bar) return;
  const ids = [...state.selection];
  const multi = ids.length > 1;
  bar.hidden = !multi;
  if (!multi) return;
  let notes = 0, canv = 0;
  for (const id of ids) {
    const n = state.nodes.get(id);
    if (!n) continue;
    isCanvasNode(n) ? canv++ : notes++;
  }
  $('#selCount').textContent = ids.length;
  $('#selWhat').textContent = [notes ? notes + ' 篇笔记' : '', canv ? canv + ' 块画布' : ''].filter(Boolean).join(' · ');
}

let hoverSeq = 0;

function placeHover(el, width) {
  const r = el.getBoundingClientRect();
  const h = hovercard.offsetHeight;
  let left = r.right + 14;
  if (left + width + 12 > window.innerWidth) left = r.left - width - 14;
  let top = r.top - 4;
  if (top + h > window.innerHeight - 14) top = window.innerHeight - h - 14;
  hovercard.style.left = Math.max(12, left) + 'px';
  hovercard.style.top = Math.max(60, top) + 'px';
}

function bindHoverCard(n, el, width) {
  clearTimeout(state.hideTimer);
  hovercard.onmouseenter = () => clearTimeout(state.hideTimer);
  hovercard.onmouseleave = scheduleHideHover;
  hovercard.querySelector('[data-enter]')?.addEventListener('click', () => {
    hideHover();
    enterCanvas(n);
  });
  hovercard.querySelector('[data-open]')?.addEventListener('click', () => {
    const t = state.nodes.get(n.id);
    hideHover();
    if (t) openEditor(t);
  });
  placeHover(el, width);
}

function showHover(n, el) {
  if (isCanvasNode(n)) { showCanvasHover(n, el); return; }
  const seq = ++hoverSeq;
  state.hovered = n.id;
  hovercard.classList.remove('wide');
  hovercard.innerHTML =
    '<h4>' + esc(n.title || '未命名') + '</h4>' +
    '<div class="hv-file">' + esc(fileNameOf(n)) + '</div>' +
    '<p>' + (esc(summaryOf(n)) || '<span style="color:var(--text-3)">还没有内容，右键可打开编辑</span>') + '</p>' +
    '<div class="row"><span>' + degree(n) + ' 条关联</span><span>·</span><span>' + ago(n.updated) + '</span><span class="spacer"></span>' +
    '<button class="ghost" data-open="' + esc(n.id) + '">打开笔记</button></div>';
  hovercard.classList.add('show');
  bindHoverCard(n, el, 292);
  if (seq !== hoverSeq) return;
}

async function showCanvasHover(n, el) {
  const seq = ++hoverSeq;
  state.hovered = n.id;
  hovercard.classList.add('wide');
  hovercard.classList.add('show');
  hovercard.innerHTML = canvasHoverHtml(n, n._peek || null);
  bindHoverCard(n, el, 300);
  const peek = await peekCanvas(n);
  if (seq !== hoverSeq || state.hovered !== n.id) return;
  hovercard.innerHTML = canvasHoverHtml(n, peek);
  bindHoverCard(n, el, 300);
  paintNode(n);
}

function canvasHoverHtml(n, peek) {
  const notes = peek ? peek.notes : [];
  const subs = peek ? peek.canvases : [];
  const shown = notes.slice(0, 5);
  const rows = [];
  for (const f of subs.slice(0, 3)) rows.push('<li class="sub"><span class="sic">▣</span>' + esc(f) + '</li>');
  if (subs.length > 3) rows.push('<li class="more sub">还有 ' + (subs.length - 3) + ' 块子画布…</li>');
  for (const f of shown) rows.push('<li>' + esc(f.replace(/\.md$/i, '')) + '</li>');
  if (notes.length > shown.length) rows.push('<li class="more">还有 ' + (notes.length - shown.length) + ' 篇…</li>');

  const list = rows.length ? '<ul class="hv-list">' + rows.join('') + '</ul>'
    : '<p class="hv-none">' + (peek ? '这块画布还是空的' : '读取中…') + '</p>';
  const sub = [notes.length + ' 篇笔记'];
  if (subs.length) sub.push(subs.length + ' 块子画布');
  sub.push((peek ? peek.edgeCount : 0) + ' 条关联');
  return '<h4>' + esc(n.title) + '</h4>' +
    '<div class="hv-file">' + esc(fileNameOf(n)) + '</div>' +
    (peek ? thumbOf(peek) : '<div class="hv-loading"></div>') +
    '<div class="hv-sub">' + sub.join(' · ') + '</div>' +
    list +
    '<div class="row"><span class="spacer"></span><button class="ghost" data-enter="' + esc(n.id) + '">进入画布 →</button></div>';
}

/* 画布缩略图：把子图的坐标按比例塞进 268×116 的框里 */
function thumbOf(peek, W = 268, H = 116) {
  const pts = [];
  const byId = new Map();
  for (const [id, p] of peek.placements) {
    const q = { id, x: p.x, y: p.y };
    pts.push(q);
    byId.set(id, q);
  }
  if (!pts.length) {
    const all = [...peek.canvases.map((c) => ({ n: c, sub: true })), ...peek.notes.map((f) => ({ n: f, sub: false }))];
    all.slice(0, 48).forEach((it, i) => {
      const q = { id: it.n, x: (i % 8) * 34, y: Math.floor(i / 8) * 30 };
      pts.push(q);
      byId.set(it.n, q);
    });
  }
  if (!pts.length) return '<div class="hv-empty">空画布</div>';

  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) {
    x1 = Math.min(x1, p.x); x2 = Math.max(x2, p.x);
    y1 = Math.min(y1, p.y); y2 = Math.max(y2, p.y);
  }
  const pad = 12;
  const bw = Math.max(x2 - x1, 1), bh = Math.max(y2 - y1, 1);
  const k = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 0.65);
  const ox = W / 2 - ((x1 + x2) / 2) * k;
  const oy = H / 2 - ((y1 + y2) / 2) * k;
  const X = (x) => (x * k + ox).toFixed(1);
  const Y = (y) => (y * k + oy).toFixed(1);

  let body = '';
  for (const e of peek.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    if (Math.hypot(a.x - b.x, a.y - b.y) > 6000) continue;   // 坐标异常时不画长线
    body += '<line x1="' + X(a.x) + '" y1="' + Y(a.y) + '" x2="' + X(b.x) + '" y2="' + Y(b.y) + '"/>';
  }
  for (const p of pts) body += '<circle cx="' + X(p.x) + '" cy="' + Y(p.y) + '" r="2.7"/>';
  return '<svg class="hv-thumb" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true">' + body + '</svg>';
}

function scheduleHideHover() {
  clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(hideHover, 200);
}
function hideHover() {
  hoverSeq++;
  hovercard.classList.remove('show');
  if (state.hovered) { state.hovered = null; renderEdges(); }
}

function showMenu(x, y, n) {
  // 右键落在多选集合里：只给整组能用的动作，避免「重命名」这类单项操作被误解成作用于全部
  if (state.selection.size > 1 && isSel(n.id)) {
    const k = state.selection.size;
    ctxmenu.innerHTML =
      '<div class="item" data-act="clearSel">取消选择<span class="k">Esc</span></div>' +
      '<div class="hr"></div>' +
      '<div class="item danger" data-act="deleteMany">删除选中的 ' + k + ' 项<span class="k">Del</span></div>';
    ctxmenu.style.left = Math.min(x, window.innerWidth - 230) + 'px';
    ctxmenu.style.top = Math.min(y, window.innerHeight - 320) + 'px';
    ctxmenu.classList.add('show');
    ctxmenu.dataset.id = n.id;
    return;
  }

  const hidden = hiddenNeighbors(n).length;
  const canCollapse = neighbors(n).some((m) => m.revealedBy.has(n.id));
  const place = (n.pos ? '<div class="item" data-act="detach">从本层移除</div>' : '<div class="item" data-act="attach">放到本层</div>');
  let html;
  if (isCanvasNode(n)) {
    html =
      '<div class="item" data-act="enter">进入画布<span class="k">双击</span></div>' +
      '<div class="item" data-act="newInside">在里面新建笔记</div>' +
      '<div class="item" data-act="newCanvasInside">在里面新建子画布</div>' +
      (hidden ? '<div class="item" data-act="expand">展开关联 (' + hidden + ')</div>' : '') +
      (canCollapse ? '<div class="item" data-act="collapse">收起关联</div>' : '') +
      '<div class="hr"></div>' +
      '<!-- 画布是文件夹，改名 = 改文件夹名 -->' +
      '<div class="item" data-act="rename">重命名画布</div>' + place +
      '<div class="hr"></div>' +
      '<div class="item danger" data-act="delete">删除画布（含全部内容）</div>';
  } else {
    html =
      '<div class="item" data-act="open">打开笔记<span class="k">双击</span></div>' +
      '<div class="item" data-act="expand">' + (hidden ? '展开关联 (' + hidden + ')' : '展开关联') + '</div>' +
      (canCollapse ? '<div class="item" data-act="collapse">收起关联</div>' : '') +
      '<div class="hr"></div>' +
      '<div class="item" data-act="rename">重命名</div>' + place +
      (atRoot() ? '' : '<div class="item" data-act="back">回到上一层</div>') +
      '<div class="hr"></div>' +
      '<div class="item danger" data-act="delete">删除笔记文件</div>';
  }
  ctxmenu.innerHTML = html;
  ctxmenu.style.left = Math.min(x, window.innerWidth - 230) + 'px';
  ctxmenu.style.top = Math.min(y, window.innerHeight - 320) + 'px';
  ctxmenu.classList.add('show');
  ctxmenu.dataset.id = n.id;
}

function closeMenu() { ctxmenu.classList.remove('show'); }
function closePopover() { popover.classList.remove('show'); }

/* ---- 通用输入对话框 ---- */
let askResolve = null;
function askText(title, value) {
  return new Promise((resolve) => {
    askResolve = resolve;
    $('#askTitle').textContent = title;
    $('#askInput').value = value || '';
    $('#askMask').classList.add('show');
    setTimeout(() => { $('#askInput').focus(); $('#askInput').select(); }, 30);
  });
}

function closeAsk(val) {
  $('#askMask').classList.remove('show');
  const r = askResolve;
  askResolve = null;
  if (r) r(val);
}

function bindAsk() {
  $('#askOk').addEventListener('click', () => closeAsk($('#askInput').value.trim()));
  $('#askCancel').addEventListener('click', () => closeAsk(null));
  $('#askInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); closeAsk($('#askInput').value.trim()); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeAsk(null); }
  });
  $('#askMask').addEventListener('pointerdown', (ev) => {
    if (ev.target === $('#askMask')) closeAsk(null);
  });
}

/* ============ 9. 建立关联 ============ */

function startLink(n, ev) {
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('class', 'temp');
  edgeLayer.appendChild(p);
  state.link = { from: n, path: p };
  stage.classList.add('linking');
  hideHover();
  moveLink(ev);
}

function moveLink(ev) {
  const w = toWorld(ev.clientX, ev.clientY);
  const s = anchor(state.link.from, { pos: w });
  state.link.path.setAttribute('d', `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} L ${w.x.toFixed(1)} ${w.y.toFixed(1)}`);
}

function finishLink(ev) {
  const from = state.link.from;
  state.link.path.remove();
  state.link = null;
  stage.classList.remove('linking');
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const hit = el && el.closest ? el.closest('.node') : null;
  if (!hit) return;
  const to = state.nodes.get(hit.dataset.id);
  if (!to || to.id === from.id) return;
  if (from.links.some((l) => l.to === to.id)) { flash('两个节点之间已经有关联了'); return; }
  openRelation(from, to, ev.clientX, ev.clientY);
}

function openRelation(from, to, x, y) {
  const label = isCanvasNode(from) ? '画布' : '笔记';
  popover.innerHTML =
    '<div class="plabel">' + esc(from.title) + ' → ' + esc(to.title) + ' <span class="ptag">' + label + '关系</span></div>' +
    '<input id="relInput" type="text" value="相关" style="width:100%" placeholder="关系名称">' +
    '<div class="chips" id="relChips">' + PRESETS.map((p) => '<span class="chip' + (p === '相关' ? ' on' : '') + '" data-t="' + p + '">' + p + '</span>').join('') + '</div>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-2)"><input type="checkbox" id="relDir" checked> 有向（A → B）</label>' +
    '<div class="foot"><span class="spacer"></span><button class="ghost" id="relCancel">取消</button><button class="primary" id="relOk">建立关联</button></div>';
  popover.style.left = Math.min(x, window.innerWidth - 276) + 'px';
  popover.style.top = Math.min(y, window.innerHeight - 236) + 'px';
  popover.classList.add('show');

  const input = $('#relInput');
  input.focus();
  input.select();

  $('#relChips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    [...$('#relChips').children].forEach((c) => c.classList.toggle('on', c === chip));
    input.value = chip.dataset.t;
  });

  const commit = () => {
    const type = input.value.trim() || '相关';
    from.links.push({ to: to.id, type, dir: $('#relDir').checked ? 1 : 0 });
    touchGraph();
    buildAdj();
    closePopover();
    select(from.id);
    renderAll();
    flash('已建立关联：' + type);
  };

  $('#relOk').addEventListener('click', commit);
  $('#relCancel').addEventListener('click', closePopover);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') commit();
    if (ev.key === 'Escape') closePopover();
  });
}

/* ============ 10. 画布交互 ============ */

let drag = null;

/* 双击要看的是「这一下点在了哪个节点」，而不是 DOM 元素——
   节点 DOM 会被重建（展开、改标题都会），元素换掉后 ev.target 就靠不住了。
   所以先信 target，再查落点，最后按坐标兜底。 */
function nodeAtPoint(clientX, clientY, target) {
  const hit = target?.closest?.('.node');
  if (hit) { const n = state.nodes.get(hit.dataset.id); if (n) return n; }
  try {
    const el = document.elementFromPoint?.(clientX, clientY)?.closest?.('.node');
    if (el) { const n = state.nodes.get(el.dataset.id); if (n) return n; }
  } catch (e) { /* 无布局环境（测试/首帧）里会抛，忽略 */ }
  const w = toWorld(clientX, clientY);
  let best = null, bestD = Infinity;
  for (const n of visibleNodes()) {
    const dx = Math.abs(w.x - n.pos.x), dy = Math.abs(w.y - n.pos.y);
    if (dx > NW / 2 || dy > NH / 2) continue;
    const d = dx + dy;
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

stage.addEventListener('pointerdown', (ev) => {
  if (ev.button === 2) return;
  closeMenu(); closePopover(); hideHover();

  const handle = ev.target.closest('.handle');
  const more = ev.target.closest('.node-more');
  const nodeHit = ev.target.closest('.node');
  const wire = ev.target.closest('path.wire');
  const multiKey = ev.ctrlKey || ev.metaKey;

  // Ctrl/⌘ + 左键 = 多选开关：只切换选中状态，不展开、不拖动、不改画布
  if (multiKey && nodeHit) {
    toggleSelect(nodeHit.dataset.id);
    return;
  }

  // 右上角 +N 就是「展开」，和单击分开，点击语义才不打架
  if (more && nodeHit) {
    const n = state.nodes.get(nodeHit.dataset.id);
    if (n) { select(n.id); toggleExpand(n); }
    return;
  }
  if (handle && nodeHit) {
    startLink(state.nodes.get(nodeHit.dataset.id), ev);
    return;
  }
  if (nodeHit) {
    const n = state.nodes.get(nodeHit.dataset.id);
    drag = { type: 'node', n, sx: ev.clientX, sy: ev.clientY, ox: n.pos.x, oy: n.pos.y, moved: false, crumbDepth: -1 };
    stage.setPointerCapture(ev.pointerId);
    // 点在多选集合里的一项上：保留整组选中，方便接着批量删除
    if (!isSel(n.id)) select(n.id);
    return;
  }
  if (wire) {
    select(state.nodes.get(wire.dataset.src)?.id || null);
    return;
  }
  drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, ox: state.view.x, oy: state.view.y, moved: false };
  stage.setPointerCapture(ev.pointerId);
  if (!multiKey) select(null);   // Ctrl 拖动画布时别把刚选好的一组清掉
});

window.addEventListener('pointermove', (ev) => {
  if (state.link) { moveLink(ev); return; }
  if (!drag) return;
  const dx = ev.clientX - drag.sx;
  const dy = ev.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) > 3) {
    drag.moved = true;
    if (drag.type === 'pan') stage.classList.add('panning');
    else {
      drag.n.el?.classList.add('dragging');   // 被拖的节点关掉位置过渡，跟手
      setCrumbsDroppable(true);               // 祖先层接得住它了，让面包屑显形
    }
  }
  if (!drag.moved) return;
  if (drag.type === 'pan') {
    state.view.x = drag.ox + dx;
    state.view.y = drag.oy + dy;
    applyView();
  } else {
    drag.n.pos.x = drag.ox + dx / state.view.k;
    drag.n.pos.y = drag.oy + dy / state.view.k;
    paintNode(drag.n);
    // 指针在顶栏面包屑上时，底下压着什么节点都不算数——两个落点不叠加
    const depth = crumbHit(ev.clientX, ev.clientY);
    if (drag.crumbDepth !== depth) {
      drag.crumbDepth = depth;
      markCrumbDrop(depth);
    }
    // 悬在画布节点上时把它点亮：松手就会移进去，先给个可预期
    const hit = depth < 0 ? dropHit(drag.n) : null;
    const tgt = hit && isCanvasNode(hit) ? hit : null;
    if (drag.dropTarget !== tgt) {
      drag.dropTarget?.el?.classList.remove('drop-into');
      drag.dropTarget = tgt;
      tgt?.el?.classList.add('drop-into');
    }
    renderEdges();
  }
});

window.addEventListener('pointerup', async (ev) => {
  if (state.link) { finishLink(ev); return; }
  if (!drag) { clearCrumbDrop(); return; }
  const d = drag;
  drag = null;
  stage.classList.remove('panning');
  // 单击节点只负责选中（pointerdown 已经做了），不在这里改画布，
  // 所以双击不需要任何等待、也不会顺手展开或新建
  if (d.type === 'node' && d.moved) {
    d.n.el?.classList.remove('dragging');
    d.dropTarget?.el?.classList.remove('drop-into');
    clearCrumbDrop();
    // 落点决定语义：压在面包屑上 = 移出到那一层；压在画布上 = 移进去；
    // 压在笔记上（或空地）= 自己弹开
    const depth = crumbHit(ev.clientX, ev.clientY);
    if (depth >= 0) {
      await moveOut(d.n, depth);
      return;
    }
    const hit = dropHit(d.n);
    if (hit && isCanvasNode(hit)) {
      await moveInto(d.n, hit);
      return;
    }
    const mv = { x: ev.clientX - d.sx, y: ev.clientY - d.sy };
    if (bounceOut(d.n, mv)) {
      paintNode(d.n);
      renderEdges();
      flash('这里已经有笔记了，已弹到旁边的空位');
    }
    d.n.revealedBy.clear();
    touchLayout();
  }
});

/* 指针被系统收走（切窗口、触摸取消）时，把拖动留下的视觉状态清干净，
   否则面包屑会一直挂着虚线、节点一直处于 dragging */
window.addEventListener('pointercancel', () => {
  drag?.n?.el?.classList.remove('dragging');
  drag?.dropTarget?.el?.classList.remove('drop-into');
  drag = null;
  clearCrumbDrop();
  stage.classList.remove('panning');
});

stage.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = stage.getBoundingClientRect();
  const px = ev.clientX - r.left;
  const py = ev.clientY - r.top;
  const wx = (px - state.view.x) / state.view.k;
  const wy = (py - state.view.y) / state.view.k;
  const dy = Number.isFinite(ev.deltaY) ? ev.deltaY : 0;
  const factor = Math.exp(-dy * 0.0016);
  const k = clamp(state.view.k * factor, 0.2, 2.6);
  state.view.k = k;
  state.view.x = px - wx * k;
  state.view.y = py - wy * k;
  applyView();
}, { passive: false });

/* 双击 = 打开：笔记进编辑器，画布进那一层。双击空白处才新建。 */
stage.addEventListener('dblclick', (ev) => {
  const n = nodeAtPoint(ev.clientX, ev.clientY, ev.target);
  if (n) {
    if (isCanvasNode(n)) enterCanvas(n);
    else openEditor(n);
    return;
  }
  if (ev.target.closest('path.wire')) return;
  createNote(toWorld(ev.clientX, ev.clientY));
});

nodeLayer.addEventListener('contextmenu', (ev) => {
  const el = ev.target.closest('.node');
  if (!el) return;
  ev.preventDefault();
  const n = state.nodes.get(el.dataset.id);
  if (!n) return;
  // 已经多选时右键其中一项：保留整组选中，菜单里直接给批量删除
  if (!isSel(n.id)) select(n.id);
  showMenu(ev.clientX, ev.clientY, n);
});

edgeLayer.addEventListener('contextmenu', (ev) => {
  const p = ev.target.closest('path.wire');
  if (!p) return;
  ev.preventDefault();
  const src = state.nodes.get(p.dataset.src);
  const l = src && src.links[+p.dataset.idx];
  if (!l) return;
  const target = state.nodes.get(l.to);
  if (!confirm('删除这条关联？\n' + src.title + ' —' + (l.type ? '(' + l.type + ')— ' : '— ') + (target ? target.title : l.to))) return;
  src.links.splice(+p.dataset.idx, 1);
  touchGraph();
  buildAdj();
  renderAll();
});

ctxmenu.addEventListener('click', async (ev) => {
  const item = ev.target.closest('.item');
  if (!item) return;
  const act = item.dataset.act;
  const n = state.nodes.get(ctxmenu.dataset.id);
  closeMenu();
  if (act === 'deleteMany') { await deleteSelected(); return; }
  if (act === 'clearSel') { select(null); return; }
  if (!n) return;

  if (act === 'enter') { await enterCanvas(n); return; }
  if (act === 'open') { openEditor(n); return; }
  if (act === 'newInside') {
    await enterCanvas(n);
    createNote();
    return;
  }
  if (act === 'newCanvasInside') {
    await enterCanvas(n);
    await createCanvas();
    return;
  }
  if (act === 'expand') { const h = hiddenNeighbors(n); h.forEach((m, i) => reveal(m, n, i, h.length)); renderAll(); touchLayout(); return; }
  if (act === 'collapse') { collapseFrom(n); renderAll(); touchLayout(); return; }
  if (act === 'detach') { n.pos = null; n.revealedBy.clear(); renderAll(); touchLayout(); return; }
  if (act === 'attach') {
    n.pos = defaultPos();
    renderAll();
    touchLayout();
    return;
  }
  if (act === 'rename') {
    if (isCanvasNode(n)) {
      const name = await askText('重命名画布（会改文件夹名）', n.title);
      if (name && name !== n.title) await renameCanvas(n, name);
    } else {
      openEditor(n);
      $('#editTitle').focus();
      $('#editTitle').select();
    }
    return;
  }
  if (act === 'back') { await goUp(); return; }
  if (act === 'delete') {
    if (isCanvasNode(n)) await deleteCanvas(n);
    else await deleteNote(n);
  }
});

document.addEventListener('pointerdown', (ev) => {
  if (!ctxmenu.contains(ev.target)) closeMenu();
  if (!popover.contains(ev.target) && !ev.target.closest('.handle')) closePopover();
}, true);

/* ============ 11. 编辑器 ============ */

function openEditor(n) {
  if (!n || isCanvasNode(n)) return;
  state.editing = n;
  $('#editTitle').value = n.title || '';
  $('#editBody').value = n.body || '';
  $('#editor').classList.add('open');
  $('#editSaved').textContent = '未修改';
  $('#editMeta').textContent = degree(n) + ' 条关联 · ' + (n.file || '尚未保存到磁盘');
  switchTab('write');
  setTimeout(() => $('#editBody').focus(), 60);
}

/* 预览要显示的就是文件里的样子：H1 + 正文 */
const editorSource = () => '# ' + ($('#editTitle').value.trim() || '未命名') + '\n\n' + $('#editBody').value;

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
  $('#editBody').style.display = tab === 'write' ? '' : 'none';
  $('#editPreview').style.display = tab === 'read' ? '' : 'none';
  if (tab === 'read') $('#editPreview').innerHTML = renderMd(editorSource());
}

/* 把编辑器里的内容同步回节点。标题框改的就是正文第一行的 H1。 */
function syncEditing() {
  const n = state.editing;
  if (!n || isCanvasNode(n)) return null;
  const newTitle = $('#editTitle').value.trim() || '未命名';
  const renamed = newTitle !== n.title;
  n.title = newTitle;
  n.body = $('#editBody').value;
  return { n, renamed };
}

async function closeEditor() {
  const s = syncEditing();
  $('#editor').classList.remove('open');
  state.editing = null;
  if (s) await persist(s.n, s.renamed);
  renderAll();
}

async function saveEditor() {
  const s = syncEditing();
  if (!s) return;
  const { n, renamed } = s;
  await persist(n, renamed);
  $('#editSaved').textContent = '已保存';
  $('#editMeta').textContent = degree(n) + ' 条关联 · ' + (n.file || '尚未保存到磁盘');
  renderAll();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
$('#btnSave').addEventListener('click', saveEditor);
$('#btnCloseEditor').addEventListener('click', closeEditor);
$('#editTitle').addEventListener('input', () => {
  $('#editSaved').textContent = '有未保存修改';
  if (document.querySelector('.tab.on')?.dataset.tab === 'read') {
    $('#editPreview').innerHTML = renderMd(editorSource());
  }
});
$('#editBody').addEventListener('input', () => {
  $('#editSaved').textContent = '有未保存修改';
  if (document.querySelector('.tab.on')?.dataset.tab === 'read') {
    $('#editPreview').innerHTML = renderMd(editorSource());
  }
});

/* ============ 12. 笔记持久化（只发生在画布文件夹里） ============ */

function fileFor(n) {
  const base = (n.title || '未命名').replace(/[\\/:*?"<>|\n]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名';
  const used = new Set([...state.nodes.values()].filter((x) => x !== n).map((x) => x.file));
  let name = base + '.md', i = 2;
  while (used.has(name)) name = base + ' (' + (i++) + ').md';
  return name;
}

async function writeNoteFile(n) {
  if (!state.dir) return false;
  try {
    await writeTextTo(state.dir, n.file, serializeNote(n));
    return true;
  } catch (err) {
    console.error(err);
    flash('写入失败：' + err.message);
    return false;
  }
}

async function persist(n, renamed) {
  if (!state.dir) { flash('还没有选择笔记目录'); return; }
  n.updated = Date.now();

  const oldFile = n.file;
  if (renamed || !n.file) {
    const next = fileFor(n);
    if (next !== n.file) { n.file = next; n.id = next; }
  }
  n.id = n.file;

  const ok = await writeNoteFile(n);
  if (!ok) return;
  if (oldFile && oldFile !== n.file) await renameRefs(n, oldFile);
}

/* 改名：换内存 key、改所有指向它的边、改坐标表，最后删旧文件 */
async function renameRefs(n, oldFile) {
  state.nodes.delete(oldFile);
  state.nodes.set(n.id, n);
  for (const m of state.nodes.values()) {
    for (const l of m.links) if (l.to === oldFile) l.to = n.id;
  }
  const p = state.layout.get(oldFile);
  if (p) { state.layout.delete(oldFile); state.layout.set(n.id, p); }
  if (state.selection.delete(oldFile)) state.selection.add(n.id);
  if (state.selected === oldFile) state.selected = n.id;
  if (state.hovered === oldFile) state.hovered = n.id;
  if (state.dir) { try { await state.dir.removeEntry(oldFile); } catch (e) { /* 旧文件可能已不存在 */ } }
  state.dirtyGraph = true;
  state.dirtyLayout = true;
  buildAdj();
  await flushWrites();
}

function removeNodeRefs(n) {
  for (const m of state.nodes.values()) m.links = m.links.filter((l) => l.to !== n.id);
  state.layout.delete(n.id);
  state.nodes.delete(n.id);
  n.el?.remove();
  state.selection.delete(n.id);
  if (state.selected === n.id) state.selected = null;
  if (state.hovered === n.id) state.hovered = null;
}

async function deleteNote(n) {
  if (!confirm('删除「' + n.title + '」？\n对应 Markdown 文件会一起删除，且不可撤销。')) return;
  if (state.editing === n) { state.editing = null; $('#editor').classList.remove('open'); }
  removeNodeRefs(n);
  if (state.dir && n.file) {
    try { await state.dir.removeEntry(n.file); } catch (e) { /* ignore */ }
  }
  state.dirtyGraph = true;
  state.dirtyLayout = true;
  await flushWrites();
  renderAll();
  renderCrumbs();
  flash('已删除');
}

/* ============ 13. 画布（文件夹）的增删改 —— 任意层级 ============ */

async function createCanvas(name) {
  if (!state.dir) return;
  let folder = name;
  if (folder === undefined) {
    const typed = await askText('新建子画布（会在本层建一个同名文件夹）', '新画布 ' + (state.nodes.size + 1));
    if (!typed) return;
    folder = typed;
  }
  const target = uniqueDirName(folder);
  let dir;
  try {
    dir = await state.dir.getDirectoryHandle(target, { create: true });
    await writeLayoutTo(dir, new Map());
    await writeGraphTo(dir, new Map());
  } catch (e) {
    flash('新建画布失败：' + e.message);
    return;
  }

  await loadLevel(state.dir, state.stack);
  const n = state.nodes.get(target);
  if (n) {
    n.pos = freePos(null);
    renderAll();
    touchLayout();
    flash('已创建画布「' + target + '」');
    await enterCanvas(n);
  } else {
    flash('已创建画布「' + target + '」');
  }
}

/* File System Access 没有「移动目录」：递归复制 → 核对 → 删旧 */
async function copyDirInto(src, dst) {
  let s = 0, d = 0;
  for await (const [name, h] of src.entries()) {
    s++;
    if (h.kind === 'directory') {
      const sub = await dst.getDirectoryHandle(name, { create: true });
      await copyDirInto(h, sub);
    } else {
      await writeTextTo(dst, name, await (await h.getFile()).text());
    }
    d++;
  }
  return { src: s, dst: d };
}

async function renameCanvas(n, name) {
  if (!state.dir) return;
  const old = n.id;
  const target = uniqueDirName(name);
  if (target === old) return;

  let src;
  try {
    src = await state.dir.getDirectoryHandle(old);
  } catch (e) {
    flash('找不到画布文件夹：' + old);
    return;
  }

  let dst;
  let moved;
  try {
    dst = await state.dir.getDirectoryHandle(target, { create: true });
    moved = await copyDirInto(src, dst);
  } catch (e) {
    flash('改名失败：复制出错（' + e.message + '），原文件夹未删除');
    return;
  }

  // 数量对得上才删旧目录，宁可留下一个副本也不要丢内容
  if (moved.dst < moved.src) {
    flash('改名失败：只复制了 ' + moved.dst + '/' + moved.src + ' 项，原文件夹未删除');
    return;
  }
  try {
    await state.dir.removeEntry(old, { recursive: true });
  } catch (e) {
    flash('内容已复制到「' + target + '」，但旧文件夹删不掉：' + e.message);
  }

  state.nodes.delete(old);
  n.id = target;
  n.title = target;
  n.file = target;
  n._peek = null;
  n._peekP = null;
  state.nodes.set(target, n);
  const p = state.layout.get(old);
  if (p) { state.layout.delete(old); state.layout.set(target, p); }
  for (const m of state.nodes.values()) {
    for (const l of m.links) if (l.to === old) l.to = target;
  }
  if (state.selected === old) state.selected = target;
  if (state.selection.delete(old)) state.selection.add(target);
  state.dirtyLayout = true;
  state.dirtyGraph = true;
  await flushWrites();
  renderAll();
  renderCrumbs();
  await warmPeek();
  flash('画布已改名为「' + target + '」');
}

async function deleteCanvas(n) {
  if (!state.dir) return;
  const peek = await peekCanvas(n);
  const bits = [];
  if (peek.notes.length) bits.push(peek.notes.length + ' 篇笔记');
  if (peek.canvases.length) bits.push(peek.canvases.length + ' 块子画布（含其中全部内容）');
  const body = bits.length ? '里面的 ' + bits.join('、') + ' 会一起删除。' : '这个画布文件夹是空的。';
  if (!confirm('删除画布「' + n.title + '」？\n' + body + '\n文件夹删除后不可撤销。')) return;
  if (!confirm('再确认一次：永久删除文件夹「' + n.id + '」及其全部内容？')) return;

  try {
    await state.dir.removeEntry(n.id, { recursive: true });
  } catch (e) {
    flash('删除失败：' + e.message);
    return;
  }
  removeNodeRefs(n);
  state.dirtyLayout = true;
  state.dirtyGraph = true;
  await flushWrites();
  renderAll();
  renderCrumbs();
  flash('已删除画布');
}

/* 批量删除：多选后按 Del，或右键「删除选中的 N 项」。
   笔记删 .md，画布删整个文件夹（递归）；删不掉的留在原地并报名字。 */
async function deleteSelected() {
  const list = [...state.selection].map((id) => state.nodes.get(id)).filter(Boolean);
  if (!list.length) { select(null); return; }
  if (!state.dir) { flash('还没有选择笔记目录'); return; }
  if (list.length === 1) {
    // 只剩一项就退回单项删除，沿用那边更细的确认文案与双重确认
    const one = list[0];
    if (isCanvasNode(one)) await deleteCanvas(one);
    else await deleteNote(one);
    return;
  }

  const notes = list.filter((n) => !isCanvasNode(n));
  const canvases = list.filter(isCanvasNode);

  const brief = (arr, max) => arr.slice(0, max).map((n) => '「' + n.title + '」').join('、') + (arr.length > max ? ' 等' : '');
  const lines = ['删除选中的 ' + list.length + ' 项？'];
  if (notes.length) lines.push('· ' + notes.length + ' 篇笔记：' + brief(notes, 3));
  if (canvases.length) {
    // 画布是文件夹，先数一下里面有多少东西，别让人糊里糊涂删掉一整个子树
    let innerNotes = 0, innerCanvas = 0;
    for (const c of canvases) {
      const p = await peekCanvas(c);
      innerNotes += p.notes.length;
      innerCanvas += p.canvases.length;
    }
    const inside = [innerNotes ? innerNotes + ' 篇笔记' : '', innerCanvas ? innerCanvas + ' 块子画布' : ''].filter(Boolean).join('、');
    lines.push('· ' + canvases.length + ' 块画布：' + brief(canvases, 2) + (inside ? '（里面还有 ' + inside + '）' : ''));
  }
  lines.push('');
  lines.push('文件会从磁盘删除，且不可撤销。');
  if (!confirm(lines.join('\n'))) return;
  if (canvases.length && !confirm('再确认一次：永久删除 ' + canvases.length + ' 个画布文件夹及其全部内容？')) return;

  if (state.editing && state.selection.has(state.editing.id)) {
    state.editing = null;
    $('#editor').classList.remove('open');
  }
  hideHover();
  closeMenu();

  const failed = [];
  let done = 0;
  for (const n of list) {
    const name = isCanvasNode(n) ? n.id : n.file || n.id;
    try {
      await state.dir.removeEntry(name, { recursive: isCanvasNode(n) });
    } catch (e) {
      // 文件已经不在磁盘上了（在资源管理器里删过）：照样从画布里拿掉
      if (e && e.name === 'NotFoundError') { /* fallthrough */ }
      else { failed.push(n.title); continue; }
    }
    removeNodeRefs(n);
    done++;
  }

  state.selection.clear();
  state.selected = null;
  state.dirtyLayout = true;
  state.dirtyGraph = true;
  await flushWrites();
  renderAll();
  renderCrumbs();
  flash(failed.length
    ? '已删除 ' + done + ' 项，' + failed.length + ' 项没删掉：' + failed.join('、')
    : '已删除 ' + done + ' 项');
}

/* ============ 14. 载入 ============ */

function resetGraph() {
  for (const n of state.nodes.values()) n.el?.remove();
  if (nodeLayer) nodeLayer.textContent = '';
  state.nodes.clear();
  state.adj = new Map();
  state.layout = new Map();
  state.selected = null;
  state.selection.clear();
  state.hovered = null;
  state.search = '';
  const s = $('#search');
  if (s) s.value = '';
  clearTimeout(state.layoutTimer);
  clearTimeout(state.graphTimer);
  state.dirtyLayout = false;
  state.dirtyGraph = false;
}

function mkCanvasNode(name) {
  return {
    id: name,
    kind: 'canvas',
    title: name,
    file: name,
    body: '',
    links: [],
    pos: null,
    revealedBy: new Set(),
    updated: 0,
    el: null,
    _peek: null,
    _peekP: null,
  };
}

function resolveRef(ref) {
  if (!ref) return null;
  if (state.nodes.has(ref)) return ref;
  if (state.nodes.has(ref + '.md')) return ref + '.md';
  return null;
}

function applyLinks(graph, legacyMap) {
  const resolve = (ref) => resolveRef(ref) || (legacyMap && legacyMap.get(ref)) || null;
  for (const [from, list] of graph) {
    const key = resolve(from);
    const n = key ? state.nodes.get(key) : null;
    if (!n) continue;
    n.links = list
      .map((l) => ({ to: resolve(l.to), type: l.type, dir: l.dir }))
      .filter((l) => l.to && l.to !== n.id);
    n.links = dedupeLinks(n);
  }
}

function applyLayout() {
  for (const n of state.nodes.values()) {
    const p = state.layout.get(n.id);
    n.pos = p ? { x: p.x, y: p.y } : null;
    n.revealedBy.clear();
  }
}

/* 新库里第一次打开：把节点摆成网格，别全叠在原点 */
function seedLayout() {
  const list = [...state.nodes.values()];
  const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
  const cw = 232, ch = 152;
  list.forEach((n, i) => {
    const x = 900 + (i % cols) * cw - ((cols - 1) * cw) / 2;
    const y = 640 + Math.floor(i / cols) * ch;
    n.pos = { x, y };
    state.layout.set(n.id, { x, y });
  });
  touchLayout();
}

/* 载入一层：这一层的节点 = 子文件夹（子画布）+ .md（笔记），两种同层共存 */
async function loadLevel(dir, stack) {
  if (state.editing) await closeEditor();   // 切层前先保存正在编辑的笔记
  await flushWrites();                      // 再把上一层的坐标和关系落盘
  resetGraph();
  state.dir = dir;
  state.stack = stack;
  state.selected = null;
  state.selection.clear();

  const files = [];
  const legacyLayouts = [];
  for await (const [name, h] of dir.entries()) {
    if (!name || name.startsWith('.')) continue;
    if (h.kind === 'directory') { state.nodes.set(name, mkCanvasNode(name)); continue; }
    if (!/\.md$/i.test(name)) continue;
    if (isMetaFile(name)) {
      if (isLegacyLayout(name)) legacyLayouts.push(name);   // 旧版画布文件：只当坐标来源，不是笔记
      continue;
    }
    files.push(name);
  }

  await Promise.all(files.map(async (name) => {
    try {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      const p = splitNote(await file.text());
      state.nodes.set(name, {
        id: name,
        kind: 'note',
        file: name,
        title: p.title || name.replace(/\.md$/i, ''),
        body: p.body,
        prefix: p.prefix,
        links: [],
        pos: null,
        revealedBy: new Set(),
        updated: file.lastModified || Date.now(),
        el: null,
        _legacyId: p.id,
        _legacyRel: p.rel,
      });
    } catch (err) {
      console.warn('跳过', name, err);
    }
  }));

  // 旧格式：id 还写在笔记 frontmatter 里的库
  const legacyMap = new Map();
  for (const n of state.nodes.values()) if (n._legacyId) legacyMap.set(n._legacyId, n.id);

  const gtext = await readMeta(dir, GRAPH_FILE, LEGACY_GRAPH_FILE);
  applyLinks(gtext ? parseGraph(gtext) : new Map(), legacyMap);

  // 旧 rel：并进当层关系表，笔记文件等下次保存时自然变干净
  let carried = 0;
  for (const n of state.nodes.values()) {
    for (const r of n._legacyRel || []) {
      const to = resolveRef(r.to) || legacyMap.get(r.to);
      const type = r.type || '';
      if (!to || to === n.id) continue;
      if (n.links.some((l) => l.to === to && l.type === type)) continue;
      n.links.push({ to, type, dir: r.dir === '0' ? 0 : 1 });
      carried++;
    }
    delete n._legacyRel;
    delete n._legacyId;
    n.links = dedupeLinks(n);
  }

  const ltext = await readMeta(dir, LAYOUT_FILE, LEGACY_LAYOUT_FILE);
  state.layout = ltext ? parseLayout(ltext) : new Map();
  // 旧坐标按旧 id 存的，换成文件名，否则这些节点会被判成「没上板」
  for (const [oldId, file] of legacyMap) {
    const p = state.layout.get(oldId);
    if (p && !state.layout.has(file)) { state.layout.delete(oldId); state.layout.set(file, p); }
  }

  // 旧版把坐标分散在各块画的 `<画布名>.canvas.md` 里；现在一层只有一张表，
  // 就把它们并进来（哪个文件先给坐标就用哪个，已有的 StarNotes.canvas.md 优先）。
  let refilled = 0;
  for (const name of legacyLayouts) {
    for (const [k, p] of parseLayout(await readText(dir, name))) {
      const key = legacyMap.get(k) || k;
      if (state.layout.has(key)) continue;
      state.layout.set(key, p);
      refilled++;
    }
  }
  applyLayout();
  buildAdj();

  if (state.nodes.size && !state.layout.size) seedLayout();
  if (carried) touchGraph();
  if (refilled) touchLayout();   // 顺手写回 StarNotes.canvas.md，下次不用再合并

  /* 老库迁移：这一层的表还是改名前的 StarNote.*.md 时，按新名各写一份。
     不删旧文件（里面是用户上一次的布局，删不删他自己定），只是让下次打开
     直接命中新名，不用再走两次读取的兜底。 */
  if (ltext && !(await hasFile(dir, LAYOUT_FILE))) touchLayout();
  if (gtext && !(await hasFile(dir, GRAPH_FILE))) touchGraph();

  renderAll();
  renderCrumbs();
  renderHint();
  updateToolbar();
  fitView();

  await warmPeek();

  if (refilled && legacyLayouts.length) {
    flash('已从旧版画布文件读取坐标（' + legacyLayouts.join('、') + '）；原文件未改动，可以手动删掉');
  }
}

async function enterCanvas(node) {
  if (!state.dir) return;
  const n = typeof node === 'string' ? state.nodes.get(node) : node;
  if (!n || !isCanvasNode(n)) return;
  if (state.editing) await closeEditor();
  let dir;
  try {
    dir = await state.dir.getDirectoryHandle(n.id);
  } catch (e) {
    flash('找不到画布文件夹「' + n.id + '」，可能在文件管理器里被删了');
    return;
  }
  await loadLevel(dir, state.stack.concat({ name: n.id, dir }));
}

/* 跳到路径上的第 i 层（面包屑点击） */
async function goTo(i) {
  if (!state.vault || i < 0 || i >= state.stack.length) return;
  if (i === state.stack.length - 1) return;
  if (state.editing) await closeEditor();
  const next = state.stack.slice(0, i + 1);
  await loadLevel(next[i].dir, next);
}

async function goUp() {
  if (atRoot()) return;
  await goTo(state.stack.length - 2);
}

/* ============ 15. 新建 / 搜索 / 提示 ============ */

function createNote(world) {
  if (!state.dir) {
    flash('还没有选择笔记目录');
    return;
  }
  const n = {
    id: '', kind: 'note', title: '新笔记', body: '', prefix: '', links: [],
    pos: freePos(world), revealedBy: new Set(), updated: Date.now(), el: null, file: '',
  };
  n.file = fileFor(n);
  n.id = n.file;
  n.title = n.file.replace(/\.md$/i, '');
  state.nodes.set(n.id, n);

  writeNoteFile(n);
  touchLayout();
  renderAll();
  renderCrumbs();
  select(n.id);
  openEditor(n);
  $('#editTitle').focus();
  $('#editTitle').select();
}

function flash(msg) {
  const hint = $('.hint');
  if (!hint) return;
  clearTimeout(flash.t);
  hint.textContent = msg;
  flash.t = setTimeout(() => { hint.textContent = state.hintBase; }, 2400);
}

/* ============ 16. 顶栏 / 快捷键 ============ */

bindAsk();
$('#btnOpen').addEventListener('click', async () => {
  if (state.editing) await closeEditor();
  await openVault();
});
$('#btnNewNote').addEventListener('click', () => createNote());
$('#btnNewCanvas').addEventListener('click', () => createCanvas());
$('#btnFit').addEventListener('click', fitView);
$('#crumbs').addEventListener('click', (ev) => {
  const b = ev.target.closest('.crumb[data-depth]');
  if (b) goTo(+b.dataset.depth);
});

$('#search').addEventListener('input', (ev) => {
  state.search = ev.target.value;
  renderAll();
});
$('#search').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const q = state.search.trim().toLowerCase();
  if (!q) return;
  const hit = [...state.nodes.values()].find((n) => (n.title + ' ' + (n.body || '')).toLowerCase().includes(q));
  if (hit) { select(hit.id); focusOn(hit); }
});

/* 多选浮条 */
$('#selDelete').addEventListener('click', () => deleteSelected());
$('#selClear').addEventListener('click', () => select(null));

document.addEventListener('keydown', (ev) => {
  const meta = ev.metaKey || ev.ctrlKey;
  // 弹层开着时键盘归它自己管（别让 Del 删了背后的笔记）。外观面板也是弹层
  const pop = ['#ghMask', '#thMask'].some((s) => { const el = $(s); return el && !el.hidden; });
  if (pop) return;
  if (meta && ev.key.toLowerCase() === 's' && state.editing) { ev.preventDefault(); saveEditor(); return; }
  if (ev.key === 'Escape') {
    if (popover.classList.contains('show')) { closePopover(); return; }
    if (ctxmenu.classList.contains('show')) { closeMenu(); return; }
    if ($('#editor').classList.contains('open')) { closeEditor(); return; }
    select(null);
  }
  if (state.editing || isTyping()) return;   // 在编辑器/输入框里按键，别抢

  // Ctrl/⌘ + A：把本层所有上板的节点一次选上
  if (meta && ev.key.toLowerCase() === 'a') {
    ev.preventDefault();
    selectAllVisible();
    return;
  }
  // Del / Backspace：删掉选中的东西（多选时一次删完）
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.selection.size) {
    ev.preventDefault();
    deleteSelected();
    return;
  }
  if (ev.key === 'Enter' && state.selected) {
    const n = state.nodes.get(state.selected);
    if (!n) return;
    if (isCanvasNode(n)) enterCanvas(n);
    else openEditor(n);
  }
  // Cmd/Ctrl + ↑ 回上一层，符合「往上走」的直觉
  if (meta && ev.key === 'ArrowUp' && !atRoot()) { ev.preventDefault(); goUp(); }
});

/* ============ 17. 启动闸门：没有文件夹就不进入 ============ */

const gate = $('#gate');
const gatePickBtn = $('#gatePick');
const gateResumeBtn = $('#gateResume');
let pendingDir = null;

function showGate(mode, dir) {
  pendingDir = dir || null;
  const title = $('#gateTitle');
  const desc = $('#gateDesc');
  const note = $('#gateNote');
  const points = $('#gatePoints');

  gate.hidden = false;
  gatePickBtn.disabled = false;
  gatePickBtn.textContent = '选择文件夹';
  gateResumeBtn.hidden = true;
  points.hidden = false;

  if (mode === 'unsupported') {
    title.textContent = '这个浏览器不行';
    desc.textContent = 'StarNotes 只通过浏览器的文件系统接口读写你本机的文件夹，不走上传、不走云端。当前浏览器没有提供这个能力。';
    points.hidden = true;
    gatePickBtn.textContent = '换用 Chrome / Edge 打开';
    gatePickBtn.disabled = true;
    note.textContent = 'Chrome、Edge 等 Chromium 内核浏览器支持；Safari 和 Firefox 目前不支持这套接口。';
    return;
  }

  if (mode === 'resume') {
    title.textContent = '继续上次的库';
    desc.textContent = '浏览器要求你重新确认一次访问权限——这是它的安全机制，不是 StarNotes 在重新索要你的文件。';
    gateResumeBtn.hidden = false;
    gateResumeBtn.textContent = dir ? '继续使用「' + dir.name + '」' : '继续使用上次的文件夹';
    gatePickBtn.textContent = '换一个文件夹';
    note.textContent = '确认后直接载入，不会移动、改名或改写任何已有文件。';
    return;
  }

  title.textContent = '先选一个文件夹';
  desc.textContent = 'StarNotes 没有默认位置，也没有内置示例库。你指定哪个文件夹，数据就写在哪里：这个文件夹本身就是一块画布，它的每个子文件夹是一块子画布，画布里的每个 .md 是一篇笔记。';
  note.textContent = '建议先在「文档」里新建一个专用空文件夹再选它。已有的 .md 会被当成笔记显示，已有子文件夹会被当成子画布——不会移动或改名任何文件。';
}

function hideGate() {
  gate.hidden = true;
  pendingDir = null;
}

async function pickFolder() {
  if (!window.showDirectoryPicker) { showGate('unsupported'); return null; }
  let dir = null;
  try {
    dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'starnote-vault', startIn: 'documents' });
  } catch (err) {
    if (err.name !== 'AbortError') flash('选择文件夹失败：' + err.message);
    return null;
  }
  try { await idbSet('dir', dir); } catch (e) { /* 句柄存不下不影响本次使用 */ }
  hideGate();
  state.vault = dir;
  syncVaultBtn();
  await loadLevel(dir, [{ name: dir.name, dir }]);
  return dir;
}

async function resumeFolder(dir) {
  if (!dir) return;
  let perm = 'denied';
  try { perm = await dir.requestPermission({ mode: 'readwrite' }); } catch (e) { /* ignore */ }
  if (perm !== 'granted') {
    flash('没有拿到访问权限，请重新选择文件夹');
    showGate('first');
    return;
  }
  hideGate();
  state.vault = dir;
  syncVaultBtn();
  await loadLevel(dir, [{ name: dir.name, dir }]);
}

async function openVault() {
  await flushWrites();     // 换库前把待写的坐标和关系落盘，别丢在旧库里
  await pickFolder();
}

/* 顶栏那个按钮一天可能一次都不点，所以文案只说清楚它选的是什么（一个目录，
   而且是笔记目录），不写「打开」——「打开文件夹」容易被读成「打开笔记」，
   也像常用功能。当前目录名放进 title：误点了别的文件夹，至少按下去之前
   能看见自己要离开的是哪一个。 */
function syncVaultBtn() {
  const b = $('#btnOpen');
  if (!b) return;
  const name = state.vault && state.vault.name;
  b.title = name ? '选择笔记目录（当前：' + name + '）' : '选择一个笔记目录';
}

gatePickBtn.addEventListener('click', async () => {
  const keep = pendingDir;
  const dir = await pickFolder();
  if (!dir && keep) showGate('resume', keep);
});
gateResumeBtn.addEventListener('click', () => resumeFolder(pendingDir));

/* ---- IndexedDB 保存目录句柄 ---- */
function idb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('starnote', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').get(k);
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  });
}

/* ============ 18. 启动 ============ */

(async function init() {
  window.addEventListener('resize', () => { /* 视图不随窗口缩放，保持用户视角 */ });
  // 切走/关标签页时兜底落盘。createWritable 是「临时文件 + close 时替换」，
  // 中途被打断不会写坏原文件，所以这里放心直接调。
  const bail = () => { if (state.dirtyLayout || state.dirtyGraph) flushWrites(); };
  window.addEventListener('pagehide', bail);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') bail();
  });

  if (!window.showDirectoryPicker) { showGate('unsupported'); return; }

  let saved = null;
  try { saved = await idbGet('dir'); } catch (e) { /* IndexedDB 不可用 */ }

  if (saved) {
    let perm = 'prompt';
    try { perm = await saved.queryPermission({ mode: 'readwrite' }); } catch (e) { /* ignore */ }
    if (perm === 'granted') { hideGate(); state.vault = saved; syncVaultBtn(); await loadLevel(saved, [{ name: saved.name, dir: saved }]); return; }
    showGate('resume', saved);
    return;
  }

  showGate('first');
})();

/* 给 github.js 这类附加模块用的一点点接口：它们在自己的 IIFE 里，
   直接引用顶层声明会踩到同名冲突，所以只透出几个函数。

   reloadLevel({discard:true}) 是给「拉取」用的：远端文件刚覆盖了本地，
   这时内存里的坐标/关系是旧的，必须先把 dirty 标记和打开的编辑器丢掉，
   否则 loadLevel 开头的 flushWrites 会拿旧数据把刚拉下来的表又写回去。 */
window.StarNotes = {
  flash,
  vault: () => state.vault,
  flushWrites,
  reloadLevel: async (opts) => {
    if (!state.dir) return;
    if (opts && opts.discard) {
      clearTimeout(state.layoutTimer);
      clearTimeout(state.graphTimer);
      state.dirtyLayout = false;
      state.dirtyGraph = false;
      state.editing = null;
      $('#editor')?.classList.remove('open');
    }
    try {
      await loadLevel(state.dir, state.stack);
    } catch (e) {
      // 当前这层可能在拉取时被删掉了，退回库根
      if (state.vault) await loadLevel(state.vault, [{ name: state.vault.name, dir: state.vault }]);
    }
  },
};
