const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');   // 仓库根：index.html / app.js 等都在这里
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const ghSrc = fs.readFileSync(path.join(ROOT, 'github.js'), 'utf8');
const themeSrc = fs.readFileSync(path.join(ROOT, 'theme.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeIDB(store) {
  return {
    open() {
      const req = {};
      const db = {
        createObjectStore() {},
        transaction() {
          const tx = {};
          tx.objectStore = () => ({
            get(key) {
              // 真 IDB 里 request.result 在 onsuccess 之前就填好了；这里同步填，
              // onsuccess 仍旧异步，两边语义才对得上
              const r = { result: store.get(key) };
              setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0);
              return r;
            },
            put(v, k) { store.set(k, v); },
          });
          setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
          return tx;
        },
      };
      setTimeout(() => { req.result = db; if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
  };
}

/* 假的目录句柄：tree 里字符串=文件内容，对象=子目录 */
function fakeDir(name, tree) {
  const handles = new Map();
  function mkFile(fn, content) {
    let text = content;
    handles.set(fn, {
      kind: 'file', name: fn,
      getFile: async () => ({ text: async () => text, lastModified: Date.now() }),
      createWritable: async () => ({ write: async (t) => { text = t; }, close: async () => {} }),
    });
  }
  const dir = {
    name, kind: 'directory', _handles: handles, _dirs: new Map(),
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { for (const [n, h] of handles) yield [n, h]; },
    getFileHandle: async (n, opt) => {
      const h = handles.get(n);
      if (h) {
        if (h.kind !== 'file') throw new Error('TypeMismatchError');
        return h;
      }
      if (!opt || !opt.create) throw new Error('NotFoundError');
      mkFile(n, '');
      return handles.get(n);
    },
    getDirectoryHandle: async (n, opt) => {
      const h = handles.get(n);
      if (h) {
        if (h.kind !== 'directory') throw new Error('TypeMismatchError');
        return h;
      }
      if (!opt || !opt.create) throw new Error('NotFoundError');
      const d = fakeDir(n, {});
      handles.set(n, d);
      dir._dirs.set(n, d);
      return d;
    },
    removeEntry: async (n) => {
      if (!handles.has(n)) throw new Error('NotFoundError');
      handles.delete(n);
      dir._dirs.delete(n);
    },
    read: async (n) => {
      const h = handles.get(n);
      return h && h.kind === 'file' ? (await h.getFile()).text() : null;
    },
    childDir: (n) => {
      const h = handles.get(n);
      return h && h.kind === 'directory' ? h : null;
    },
    has: (n) => handles.has(n),
  };
  for (const [n, v] of Object.entries(tree || {})) {
    if (typeof v === 'string') mkFile(n, v);
    else { const d = fakeDir(n, v); handles.set(n, d); dir._dirs.set(n, d); }
  }
  return dir;
}

async function boot({ withPicker, store, pick }) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:8000/' });
  const { window } = dom;
  window.indexedDB = makeIDB(store || new Map());
  window.confirm = () => true;
  if (withPicker) {
    window.showDirectoryPicker = async () => {
      if (pick) return pick;
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    };
  }
  window.eval(appSrc);
  window.eval(ghSrc);
  window.eval(themeSrc);
  await sleep(60);
  return window;
}

async function openWith(dir) {
  const w = await boot({ withPicker: true, store: new Map(), pick: dir });
  const d = w.document;
  d.getElementById('gatePick').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  return w;
}

/* 点在节点上时靠 target 命中；点在空白处（stage 自己）要靠坐标算落点，
   所以坐标要真的落在空白处，别用 10,10 这种「恰好贴着左上角节点」的点 */
const dbl = (w, el, x = 10, y = 10) => el.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
/* 一次真实的「按下—抬起」，用来验证单击展开 */
const tap = (w, el) => {
  const o = { bubbles: true, clientX: 10, clientY: 10, button: 0, pointerId: 1 };
  el.dispatchEvent(new w.MouseEvent('pointerdown', o));
  w.dispatchEvent(new w.MouseEvent('pointerup', o));
};
const click = (w, id) => w.document.getElementById(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const nodes = (w) => [...w.document.querySelectorAll('#nodeLayer .node')];
const nodeTitles = (w) => nodes(w).map((el) => el.querySelector('.node-title').textContent);
/* 未上板的节点元素还在 DOM 里但 display:none，只统计看得见的 */
const titled = (w) => nodes(w).filter((el) => el.style.display !== 'none').map((el) => el.querySelector('.node-title').textContent).filter(Boolean).sort().join(',');
const byTitle = (w, t) => nodes(w).find((el) => el.querySelector('.node-title').textContent === t);

async function ask(w, text) {
  w.document.getElementById('askInput').value = text;
  click(w, 'askOk');
  await sleep(180);
}

/* 3 层嵌套的库 */
function nestedVault() {
  return fakeDir('库', {
    '根层笔记.md': '# 根层笔记\n\n根画布上的一篇。\n',
    'StarNotes.graph.md': '---\ntype: starnote-graph\nversion: 1\n---\n\n## 知识地图\n- 写作线索 | 延伸 | →\n',
    'StarNotes.canvas.md': '---\ntype: canvas\nid: c0\nname: 库\n---\n\n- 知识地图 900 640\n- 写作线索 1200 640\n- 根层笔记.md 600 640\n',
    '知识地图': {
      '双链与反链.md': '# 双链与反链\n\n正向链接是你主动写的引用。\n',
      '知识图谱.md': '# 知识图谱\n\n节点是概念。\n',
      'StarNotes.graph.md': '---\ntype: starnote-graph\nversion: 1\n---\n\n## 双链与反链.md\n- 知识图谱.md | 前置知识 | →\n',
      'StarNotes.canvas.md': '---\ntype: canvas\nid: c1\nname: 知识地图\n---\n\n- 双链与反链.md 900 640\n- 知识图谱.md 1200 500\n- 图谱 900 400\n',
      '图谱': {
        '三层笔记.md': '# 三层笔记\n\n最深的一层。\n',
        'StarNotes.graph.md': '---\ntype: starnote-graph\nversion: 1\n---\n\n',
        'StarNotes.canvas.md': '---\ntype: canvas\nid: c2\nname: 图谱\n---\n\n- 三层笔记.md 900 640\n',
      },
    },
    '写作线索': {
      '线索一.md': '# 线索一\n\n写作。\n',
    },
  });
}

(async function run() {
  console.log('\n[1] 启动闸门');
  {
    const w = await boot({ withPicker: false });
    ok(w.document.getElementById('gate').hidden === false, '不支持浏览器时停住');
    w.close();
    const w2 = await boot({ withPicker: true });
    ok(w2.document.getElementById('gateTitle').textContent === '先选一个文件夹', '首次启动要求选文件夹');
    w2.close();
  }

  console.log('\n[2] 根层 = 画布节点 + 笔记节点，同层共存');
  {
    const dir = nestedVault();
    const w = await openWith(dir);
    const d = w.document;
    const t = nodeTitles(w).sort();
    ok(t.join(',') === ['写作线索', '根层笔记', '知识地图'].sort().join(','), '根层节点：2 画布 + 1 笔记', t.join(','));
    ok(d.getElementById('statNodes').textContent === '2 画布 · 1 篇', '统计区分画布和笔记', d.getElementById('statNodes').textContent);
    ok(d.querySelectorAll('.node.is-canvas').length === 2, '画布节点有 is-canvas 标记');
    ok(d.getElementById('statLinks').textContent.indexOf('1') === 0, '根层关系只在画布之间', d.getElementById('statLinks').textContent);
    ok(!d.querySelector('.notice'), '不再有「根目录 md 被忽略」那条提示');
    const crumbs = [...d.querySelectorAll('#crumbs .crumb')].map((c) => c.textContent.replace(/\s+/g, ''));
    ok(crumbs.length === 1 && crumbs[0].includes('库'), '面包屑只有库根一层', crumbs.join('|'));
    w.close();
  }

  console.log('\n[3] 进入画布：子画布与笔记同层');
  {
    const dir = nestedVault();
    const w = await openWith(dir);
    const d = w.document;
    dbl(w, byTitle(w, '知识地图'));
    await sleep(200);
    const t = nodeTitles(w).sort();
    ok(t.join(',') === ['双链与反链', '图谱', '知识图谱'].sort().join(','), '第二层：2 笔记 + 1 子画布', t.join(','));
    ok(d.getElementById('statNodes').textContent === '1 画布 · 2 篇', '第二层统计', d.getElementById('statNodes').textContent);
    ok(d.getElementById('statLinks').textContent.indexOf('1') === 0, '本层关系（笔记之间）1 条', d.getElementById('statLinks').textContent);
    const crumbTexts = [...d.querySelectorAll('#crumbs .crumb')].map((c) => c.textContent);
    ok(crumbTexts.length === 2 && crumbTexts[1].includes('知识地图'), '面包屑两级', crumbTexts.join('|'));
    w.close();
  }

  console.log('\n[4] 三层嵌套 + 面包屑跳回');
  {
    const dir = nestedVault();
    const w = await openWith(dir);
    const d = w.document;
    dbl(w, byTitle(w, '知识地图'));
    await sleep(200);
    dbl(w, byTitle(w, '图谱'));
    await sleep(200);
    ok(nodeTitles(w).join(',') === '三层笔记', '第三层只有那篇笔记', nodeTitles(w).join(','));
    const crumbTexts = [...d.querySelectorAll('#crumbs .crumb')].map((c) => c.textContent);
    ok(crumbTexts.length === 3, '面包屑三层', crumbTexts.join('|'));
    const first = d.querySelector('#crumbs .crumb[data-depth="0"]');
    ok(!!first, '根面包屑可点击');
    first.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(220);
    ok(nodeTitles(w).includes('知识地图') && nodeTitles(w).includes('根层笔记'), '点根面包屑回到根层的完整节点集', nodeTitles(w).join(','));
    w.close();
  }

  console.log('\n[5] 笔记仍然只写子目录，不碰上层');
  {
    const dir = nestedVault();
    const w = await openWith(dir);
    const d = w.document;
    dbl(w, byTitle(w, '知识地图'));
    await sleep(200);
    click(w, 'btnNewNote');
    await sleep(160);
    const km = dir.childDir('知识地图');
    ok(km.has('新笔记.md'), '新笔记落在当前画布文件夹里', [...km._handles.keys()].join(','));
    ok(!dir.has('新笔记.md'), '没有落到库根');
    d.getElementById('editBody').value = '写在第二层。';
    click(w, 'btnSave');
    await sleep(160);
    const text = await km.read('新笔记.md');
    ok(text.startsWith('# 新笔记') && text.includes('写在第二层'), '内容是纯 Markdown', JSON.stringify(text));
    ok(!/\brel:|\bid:\s/.test(text), '没有图数据混进笔记');
    w.close();
  }

  console.log('\n[6] 在画布里新建子画布');
  {
    const dir = nestedVault();
    const w = await openWith(dir);
    const d = w.document;
    dbl(w, byTitle(w, '知识地图'));
    await sleep(200);
    click(w, 'btnNewCanvas');
    await sleep(80);
    await ask(w, '方法论');
    await sleep(220);
    const km = dir.childDir('知识地图');
    ok(km.has('方法论'), '子画布文件夹建在当前层里', [...km._handles.keys()].join(','));
    ok(!!km.childDir('方法论'), '是目录不是文件');
    const sub = km.childDir('方法论');
    ok(sub.has('StarNotes.canvas.md') && sub.has('StarNotes.graph.md'), '新画布自带坐标/关系文件', [...sub._handles.keys()].join(','));
    const crumbTexts = [...d.querySelectorAll('#crumbs .crumb')].map((c) => c.textContent);
    ok(crumbTexts.length === 3 && crumbTexts[2].includes('方法论'), '建完直接进入新画布（三层）', crumbTexts.join('|'));
    w.close();
  }

  console.log('\n[7] 改画布名：递归搬走嵌套内容');
  {
    const dir = fakeDir('库', {
      '甲': {
        'b.md': '# b\n\n乙的内容兄弟。\n',
        'StarNotes.canvas.md': '---\ntype: canvas\nid: c1\nname: 甲\n---\n\n- b.md 900 640\n- 乙 900 400\n',
        '乙': {
          'c.md': '# c\n\n藏在第二层。\n',
          'StarNotes.canvas.md': '---\ntype: canvas\nid: c2\nname: 乙\n---\n\n- c.md 900 640\n',
        },
      },
    });
    const w = await openWith(dir);
    const d = w.document;
    const el = byTitle(w, '甲');
    el.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    await sleep(40);
    const item = [...d.querySelectorAll('.ctxmenu .item')].find((x) => x.textContent.includes('重命名'));
    item.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    await ask(w, '甲2');
    await sleep(300);
    ok(!dir.has('甲'), '旧文件夹已删除');
    const n1 = dir.childDir('甲2');
    ok(!!n1, '新文件夹已建立');
    ok(n1.has('b.md') && (await n1.read('b.md')).includes('乙的内容兄弟'), '本层笔记搬过去了');
    const n2 = n1.childDir('乙');
    ok(!!n2 && n2.has('c.md'), '嵌套子画布也搬过去了', n1 ? [...n1._handles.keys()].join(',') : 'no dir');
    ok(n2 && (await n2.read('c.md')).includes('藏在第二层'), '第三层文件内容完整');
    ok(nodeTitles(w).includes('甲2') && !nodeTitles(w).includes('甲'), '画布节点跟着改名', nodeTitles(w).join(','));
    w.close();
  }

  console.log('\n[8] 删画布：连子画布一起，关系表清干净');
  {
    const dir = fakeDir('库', {
      '甲': { 'b.md': '# b\n', '乙': { 'c.md': '# c\n' } },
      '丙': { 'd.md': '# d\n' },
      'StarNotes.graph.md': '---\ntype: starnote-graph\nversion: 1\n---\n\n## 甲\n- 丙 | 相关 | ↔\n',
      'StarNotes.canvas.md': '---\ntype: canvas\nid: c0\nname: 库\n---\n\n- 甲 900 640\n- 丙 1200 640\n',
    });
    const w = await openWith(dir);
    const d = w.document;
    const el = byTitle(w, '甲');
    el.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    await sleep(40);
    const del = [...d.querySelectorAll('.ctxmenu .item')].find((x) => x.textContent.includes('删除画布'));
    ok(!!del, '菜单里有删除画布');
    del.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(320);
    ok(!dir.has('甲'), '文件夹（含嵌套内容）已删除');
    ok(dir.has('丙'), '别的画布没被误删');
    const g = await dir.read('StarNotes.graph.md');
    ok(!g.includes('## 甲') && !g.includes('- 甲 |'), '关系表里没有指向甲的残边', g);
    const c = await dir.read('StarNotes.canvas.md');
    ok(!c.includes('- 甲 '), '坐标表里也移除了');
    ok(!nodeTitles(w).includes('甲'), '画布上没了');
    w.close();
  }

  console.log('\n[9] 旧格式（frontmatter 里带 rel）仍能迁移');
  {
    const legacy = '---\nid: nA\ntitle: 旧笔记\nrel:\n  - to: nB\n    type: 前置知识\n    dir: 1\n---\n\n正文。\n';
    const dir = fakeDir('旧库', {
      '画布': {
        '旧笔记.md': legacy,
        '目标.md': '---\nid: nB\ntitle: 目标\n---\n\n正文。\n',
        'StarNotes.canvas.md': '---\ntype: canvas\nid: c1\nname: 画布\n---\n\n- nA 100 100\n- nB 300 100\n',
      },
    });
    const w = await openWith(dir);
    const d = w.document;
    dbl(w, byTitle(w, '画布'));
    await sleep(220);
    ok(d.getElementById('statLinks').textContent.indexOf('1') === 0, '旧 rel 变成 1 条边', d.getElementById('statLinks').textContent);
    const cd = dir.childDir('画布');
    await sleep(520);
    const g = await cd.read('StarNotes.graph.md');
    ok(!!g && g.includes('## 旧笔记.md') && g.includes('目标.md'), '边搬进本层关系表，id 换成文件名', g);
    ok((await cd.read('旧笔记.md')) === legacy, '打开库时不改写用户文件');
    w.close();
  }

  console.log('\n[10] 画布 hover 卡：缩略图 + 子画布清单');
  {
    const dir = nestedVault();
    const w = await openWith(dir);
    const d = w.document;
    const el = byTitle(w, '知识地图');
    el.dispatchEvent(new w.MouseEvent('mouseenter', { bubbles: false }));
    await sleep(600);
    const card = d.getElementById('hovercard');
    ok(card.classList.contains('show'), 'hover 卡弹出');
    const text = card.textContent;
    ok(text.includes('图谱'), '列出了子画布', text.replace(/\s+/g, ' ').slice(0, 120));
    ok(text.includes('双链与反链'), '列出了笔记');
    ok(text.includes('1 块子画布'), '副标题里点了子画布数', text.match(/.*块子画布.*/)?.[0] || '');
    ok(!!card.querySelector('.hv-thumb'), '有缩略图');
    ok(!!card.querySelector('[data-enter]'), '有进入按钮');
    w.close();
  }

  console.log('\n[11] 旧版 *.canvas.md 不再冒充笔记');
  {
    const legacyCanvas = '---\ntype: canvas\nid: cMain\nname: 主画布\n---\n\n- nA 900 640\n- 认知负荷.md 1200 500\n';
    const dir = fakeDir('旧库', {
      '主画布.canvas.md': legacyCanvas,
      '双链.md': '---\nid: nA\ntitle: 双链\n---\n\n# 双链\n\n正向链接。\n',
      '认知负荷.md': '# 认知负荷\n\n工作记忆有限。\n',
    });
    const w = await openWith(dir);
    const t = nodeTitles(w);
    ok(!t.includes('主画布.canvas'), '旧画布文件没被当成笔记', t.join(','));
    ok(t.includes('双链') && t.includes('认知负荷'), '两篇真笔记都在', t.join(','));
    await sleep(700);
    const lay = await dir.read('StarNotes.canvas.md');
    ok(!!lay && lay.includes('- 双链.md 900 640'), '旧画布里的坐标迁移到本层坐标表', lay);
    ok((await dir.read('主画布.canvas.md')) === legacyCanvas, '旧画布文件原样保留');
    w.close();
  }

  console.log('\n[12] 双击 = 打开，不再顺手新建节点');
  {
    const dir = nestedVault();
    const w = await openWith(dir);
    const d = w.document;
    const before = nodes(w).length;
    dbl(w, byTitle(w, '根层笔记'));
    await sleep(140);
    ok(d.getElementById('editor').classList.contains('open'), '双击笔记：打开编辑器');
    ok(nodes(w).length === before, '节点数不变，没有新建', before + ' → ' + nodes(w).length);
    ok(d.getElementById('editTitle').value === '根层笔记', '编辑的就是被双击那篇', d.getElementById('editTitle').value);
    click(w, 'btnCloseEditor');
    await sleep(140);

    const n2 = nodes(w).length;
    dbl(w, byTitle(w, '知识地图'));
    await sleep(240);
    ok(d.querySelectorAll('#crumbs .crumb').length === 2, '双击画布：进入那一层');
    ok(nodeTitles(w).sort().join(',') === ['双链与反链', '图谱', '知识图谱'].sort().join(','), '进来是该画布的节点', nodeTitles(w).join(','));
    ok(!nodeTitles(w).includes('新笔记') && n2 === before, '全程没有多出节点', nodeTitles(w).join(','));
    w.close();
  }

  console.log('\n[13] 单击只选中，展开交给 +N 徽章');
  {
    const dir = fakeDir('库', {
      'A.md': '# A\n\n甲。\n',
      'B.md': '# B\n\n乙。\n',
      'StarNotes.graph.md': '---\ntype: starnote-graph\nversion: 1\n---\n\n## A.md\n- B.md | 相关 | ↔\n',
      'StarNotes.canvas.md': '---\ntype: canvas\nversion: 2\n---\n\n- A.md 900 640\n',
    });
    const w = await openWith(dir);
    w.HTMLElement.prototype.setPointerCapture = () => {};
    w.HTMLElement.prototype.releasePointerCapture = () => {};
    ok(titled(w) === 'A', 'B 还没上板', titled(w));

    tap(w, byTitle(w, 'A'));
    await sleep(260);
    ok(titled(w) === 'A', '单击不展开，也没有任何延迟等待', titled(w));
    ok(byTitle(w, 'A').classList.contains('selected'), '单击只是选中');

    const badge = byTitle(w, 'A').querySelector('.node-more');
    ok(!!badge && badge.textContent === '+1', '+N 徽章显示隐藏邻居数', badge && badge.textContent);
    tap(w, badge);
    await sleep(90);
    ok(titled(w) === 'A,B', '点徽章展开出 B', titled(w));
    ok(!byTitle(w, 'A').querySelector('.node-more'), '展开完徽章消失');

    // 展开后再双击，只打开，不新建也不收起
    const before = nodes(w).length;
    dbl(w, byTitle(w, 'A'));
    await sleep(140);
    ok(w.document.getElementById('editor').classList.contains('open'), '双击仍然打开编辑器');
    ok(titled(w) === 'A,B' && nodes(w).length === before, '双击既不新建也不改动画布', titled(w));
    w.close();
  }

  console.log('\n[14] 新建节点自动错开位置');
  {
    const dir = fakeDir('库', {
      'A.md': '# A\n\n甲。\n',
      'StarNotes.canvas.md': '---\ntype: canvas\nversion: 2\n---\n\n- A.md 900 640\n',
    });
    const w = await openWith(dir);
    const d = w.document;
    const box = (el) => ({ l: parseFloat(el.style.left), t: parseFloat(el.style.top) });
    const all = () => nodes(w).filter((el) => el.style.display !== 'none').map(box);
    const overlap = (a, b) => Math.abs(a.l - b.l) < 168 && Math.abs(a.t - b.t) < 88;
    const conflicts = (list) => {
      let c = 0;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (overlap(list[i], list[j])) c++;
      return c;
    };

    ok(all().length === 1 && conflicts(all()) === 0, '初始 1 个节点，无重叠', JSON.stringify(all()));

    for (let i = 0; i < 3; i++) {
      d.getElementById('btnNewNote').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await sleep(120);
    }
    await sleep(160);
    const list = all();
    ok(list.length === 4, '连点三次新建得到 4 个节点', list.length);
    ok(conflicts(list) === 0, '4 个节点两两不重叠', JSON.stringify(list.map((b) => [b.l + 84, b.t + 32])));
    ok(new Set(list.map((b) => b.l + ',' + b.t)).size === 4, '坐标互不相同');

    // 显式指定一个已被占用的坐标，也要让开
    const before = all().length;
    dbl(w, d.getElementById('stage'), 10, 520);
    await sleep(150);
    ok(all().length === before + 1, '双击空白处仍然新建', all().length);
    ok(conflicts(all()) === 0, '新建后整体仍无重叠');

    // 画布也一样
    const crumb = () => d.querySelectorAll('#crumbs .crumb[data-depth]');
    for (let i = 0; i < 2; i++) {
      d.getElementById('btnNewCanvas').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await sleep(80);
      const inp = d.getElementById('askInput');
      inp.value = '画布' + i;
      d.getElementById('askOk').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await sleep(260);
      const root = crumb()[0];
      if (root) root.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await sleep(260);
    }
    const cEls = nodes(w).filter((el) => el.style.display !== 'none' && el.querySelector('.ctag'));
    ok(cEls.length === 2, '根层有两块画布', cEls.length);
    const cb = cEls.map(box);
    ok(conflicts(cb) === 0, '两块画布不重叠', JSON.stringify(cb.map((b) => [b.l + 84, b.t + 32])));
    w.close();
  }

  console.log('\n[15] 松手判定：落笔记则弹开，落画布则移入');
  {
    const dir = fakeDir('库', {
      '笔记A.md': '# 笔记A\n\n甲。\n',
      '笔记B.md': '# 笔记B\n\n乙。\n',
      'StarNotes.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- 笔记A.md 900 640\n- 笔记B.md 1200 640\n- 画布X 900 900\n',
      '画布X': {
        '笔记C.md': '# 笔记C\n\n丙。\n',
        'StarNotes.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- 笔记C.md 900 640\n',
      },
    });
    const w = await openWith(dir);
    w.HTMLElement.prototype.setPointerCapture = () => {};
    w.HTMLElement.prototype.releasePointerCapture = () => {};
    const d = w.document;
    const posOf = (t) => {
      const el = byTitle(w, t);
      return { x: parseFloat(el.style.left) + 84, y: parseFloat(el.style.top) + 32 };
    };
    const badPairs = () => {
      const list = [...w.document.querySelectorAll('.node')]
        .filter((el) => el.style.display !== 'none')
        .map((el) => ({ x: parseFloat(el.style.left) + 84, y: parseFloat(el.style.top) + 32 }));
      const bad = [];
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        if (Math.abs(list[i].x - list[j].x) < 194 && Math.abs(list[i].y - list[j].y) < 90) bad.push(i + '-' + j);
      }
      return bad;
    };
    const ev = (type, x, y) => new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 });

    // 先用一小步量出缩放比，再把节点挪回原位松手
    const A0 = posOf('笔记A');
    byTitle(w, '笔记A').dispatchEvent(ev('pointerdown', 0, 0));
    w.dispatchEvent(ev('pointermove', 10, 0));
    await sleep(20);
    const k = 10 / (posOf('笔记A').x - A0.x);
    w.dispatchEvent(ev('pointermove', 0, 0));
    w.dispatchEvent(ev('pointerup', 0, 0));
    await sleep(30);
    ok(Math.abs(posOf('笔记A').x - A0.x) < 0.01, '量缩放比不影响原位置');

    const dropOn = async (title, tx, ty) => {
      const from = posOf(title);
      byTitle(w, title).dispatchEvent(ev('pointerdown', 0, 0));
      w.dispatchEvent(ev('pointermove', (tx - from.x) * k, (ty - from.y) * k));
      await sleep(20);
      w.dispatchEvent(ev('pointerup', (tx - from.x) * k, (ty - from.y) * k));
      await sleep(80);
    };

    // 1) 压到另一篇笔记上：对方不动，自己弹开
    const bBefore = posOf('笔记B');
    const xBefore = posOf('画布X');
    await dropOn('笔记A', 1200, 640);
    ok(Math.abs(posOf('笔记B').x - bBefore.x) < 0.01, '被压的笔记一动不动', posOf('笔记B').x);
    ok(Math.abs(posOf('画布X').x - xBefore.x) < 0.01, '旁边的画布也不动');
    ok(Math.abs(posOf('笔记A').x - 1200) >= 194 || Math.abs(posOf('笔记A').y - 640) >= 90,
      '自己弹开，不压在笔记 B 上', JSON.stringify(posOf('笔记A')));
    ok(badPairs().length === 0, '松手后没有重叠', JSON.stringify(badPairs()));

    // 2) 压到画布节点上：先点亮，松手才移进去
    const from2 = posOf('笔记A');
    byTitle(w, '笔记A').dispatchEvent(ev('pointerdown', 0, 0));
    w.dispatchEvent(ev('pointermove', (900 - from2.x) * k, (900 - from2.y) * k));
    await sleep(30);
    ok(byTitle(w, '画布X').classList.contains('drop-into'), '悬在画布上时画布被点亮');
    w.dispatchEvent(ev('pointerup', (900 - from2.x) * k, (900 - from2.y) * k));
    await sleep(100);
    ok(!w.document.querySelector('.node[data-id="笔记A.md"]') ||
       byTitle(w, '笔记A') === null, '笔记 A 已从本层消失');
    ok(dir.has('笔记A.md') === false, '根目录里的文件被搬走了');
    const xdir = dir.childDir('画布X');
    ok(!!xdir && xdir.has('笔记A.md'), '文件进了画布 X 文件夹');
    ok((await xdir.read('笔记A.md')).indexOf('# 笔记A') === 0, '内容原样带过去');
    ok(/笔记A\.md/.test(await xdir.read('StarNotes.canvas.md')), '在画布 X 里也给了落点');
    await sleep(600);
    ok(!/笔记A\.md/.test(await dir.read('StarNotes.canvas.md')), '根层坐标表已摘掉它');

    // 3) 落到空地：位置就是松手那一点
    const before3 = posOf('笔记B');
    byTitle(w, '笔记B').dispatchEvent(ev('pointerdown', 0, 0));
    w.dispatchEvent(ev('pointermove', -300 * k, -200 * k));
    await sleep(20);
    const spot = posOf('笔记B');
    w.dispatchEvent(ev('pointerup', -300 * k, -200 * k));
    await sleep(60);
    const after3 = posOf('笔记B');
    ok(Math.abs(after3.x - spot.x) < 0.01 && Math.abs(after3.y - spot.y) < 0.01, '落在空地不会被挪', JSON.stringify([spot, after3]));
    ok(Math.abs(after3.x - (before3.x - 300)) < 2, '位置就是松手的地方', after3.x);
    w.close();
  }

  console.log('\n[16] Ctrl+点击多选，Del / 右键批量删除');
  {
    const dir = fakeDir('库', {
      'A.md': '# A\n\n甲。\n',
      'B.md': '# B\n\n乙。\n',
      'C.md': '# C\n\n丙。\n',
      'X': {
        'X1.md': '# X1\n\n画布里的一篇。\n',
        'StarNotes.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- X1.md 900 640\n',
      },
      'StarNotes.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- A.md 700 500\n- B.md 1000 500\n- C.md 700 780\n- X 1000 780\n',
      'StarNotes.graph.md': '---\ntype: starnote-graph\nversion: 1\n---\n\n## A.md\n- B.md | 对比 | ↔\n',
    });
    const w = await openWith(dir);
    const d = w.document;
    w.HTMLElement.prototype.setPointerCapture = () => {};
    w.HTMLElement.prototype.releasePointerCapture = () => {};
    const bar = () => d.getElementById('selBar');
    const selTitles = () => nodes(w).filter((el) => el.classList.contains('selected'))
      .map((el) => el.querySelector('.node-title').textContent).sort().join(',');
    const multiKeyTap = (el) => {
      const o = { bubbles: true, clientX: 10, clientY: 10, button: 0, pointerId: 1, ctrlKey: true };
      el.dispatchEvent(new w.MouseEvent('pointerdown', o));
      w.dispatchEvent(new w.MouseEvent('pointerup', o));
    };
    const key = (k, opt) => d.dispatchEvent(new w.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, opt)));

    ok(titled(w) === 'A,B,C,X', '四个节点都在画布上', titled(w));

    tap(w, byTitle(w, 'A'));
    ok(selTitles() === 'A', '单击只选一个', selTitles());
    ok(bar().hidden, '单选时不显示多选浮条');

    multiKeyTap(byTitle(w, 'B'));
    await sleep(30);
    ok(selTitles() === 'A,B', 'Ctrl+点击把 B 加进选择', selTitles());
    ok(!bar().hidden, '多选时浮条出现');
    ok(d.getElementById('selCount').textContent === '2', '浮条显示已选 2 项', d.getElementById('selCount').textContent);
    ok(d.getElementById('selWhat').textContent === '2 篇笔记', '浮条按类型报数量', d.getElementById('selWhat').textContent);
    ok(byTitle(w, 'A').classList.contains('multi') && byTitle(w, 'B').classList.contains('multi'), '两张卡片都标成多选态');
    ok(!byTitle(w, 'C').classList.contains('selected'), '没点到的节点不受影响');

    multiKeyTap(byTitle(w, 'C'));
    await sleep(30);
    ok(selTitles() === 'A,B,C', '继续 Ctrl+点击 = 继续累加', selTitles());

    multiKeyTap(byTitle(w, 'C'));
    await sleep(30);
    ok(selTitles() === 'A,B', '再次 Ctrl+点击 = 从选择里拿掉', selTitles());

    key('Escape');
    await sleep(30);
    ok(selTitles() === '', 'Esc 清空选择', JSON.stringify(selTitles()));
    ok(bar().hidden, '清空后浮条收起');

    // Ctrl+A 全选（含画布节点）
    key('a', { ctrlKey: true });
    await sleep(30);
    ok(selTitles() === 'A,B,C,X', 'Ctrl+A 选中本层全部节点', selTitles());
    ok(d.getElementById('selWhat').textContent === '3 篇笔记 · 1 块画布', '浮条分别数笔记与画布', d.getElementById('selWhat').textContent);
    key('Escape');
    await sleep(20);

    // 右键多选中的一项：菜单只给批量动作，且不清掉这一组
    multiKeyTap(byTitle(w, 'A'));
    multiKeyTap(byTitle(w, 'B'));
    await sleep(30);
    byTitle(w, 'B').dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 120 }));
    await sleep(30);
    ok(selTitles() === 'A,B', '右键不清空已有的多选', selTitles());
    const delItem = d.querySelector('#ctxmenu .item[data-act="deleteMany"]');
    ok(!!delItem && /2/.test(delItem.textContent), '菜单里是「删除选中的 2 项」', delItem && delItem.textContent);
    ok(!d.querySelector('#ctxmenu .item[data-act="rename"]'), '多选时不出现只作用于单个节点的项');
    delItem.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(400);
    ok(titled(w) === 'C,X', '两项一起从画布上消失', titled(w));
    ok(dir.has('A.md') === false && dir.has('B.md') === false, '两个 .md 文件一起从磁盘删掉');
    ok(dir.has('X') === true && dir.has('C.md') === true, '没选中的文件与画布都还在');
    ok(bar().hidden, '删完浮条收起');
    await sleep(400);
    ok(!/A\.md|B\.md/.test(await dir.read('StarNotes.canvas.md')), '坐标表里也清掉了它们');

    // 笔记 + 画布混选，Del 键一次删完（画布连文件夹一起删）
    tap(w, byTitle(w, 'C'));
    multiKeyTap(byTitle(w, 'X'));
    await sleep(30);
    ok(selTitles() === 'C,X', '笔记与画布可以混选', selTitles());
    ok(d.getElementById('selWhat').textContent === '1 篇笔记 · 1 块画布', '浮条写明混合选择', d.getElementById('selWhat').textContent);
    key('Delete');
    await sleep(500);
    ok(titled(w) === '', 'Del 把选中的笔记和画布一起删掉', JSON.stringify(titled(w)));
    ok(dir.has('C.md') === false, '笔记文件已删');
    ok(dir.has('X') === false, '画布文件夹（连同里面的笔记）已整个删掉');
    ok(dir.has('StarNotes.canvas.md') && dir.has('StarNotes.graph.md'), '本层的两张表还在');

    w.close();
  }
  {
    // 在编辑器里按 Del 不能删节点（别抢输入）
    const dir = fakeDir('库', {
      'A.md': '# A\n\n甲。\n',
      'StarNotes.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- A.md 900 640\n',
    });
    const w = await openWith(dir);
    const d = w.document;
    w.HTMLElement.prototype.setPointerCapture = () => {};
    w.HTMLElement.prototype.releasePointerCapture = () => {};
    tap(w, byTitle(w, 'A'));
    dbl(w, byTitle(w, 'A'));
    await sleep(140);
    ok(d.getElementById('editor').classList.contains('open'), '先在编辑器里', '');
    d.getElementById('editBody').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await sleep(100);
    ok(dir.has('A.md') === true && titled(w) === 'A', '在编辑器里按 Del 不会删笔记', titled(w));
    w.close();
  }

  console.log('\n[17] 绑定 GitHub：字段校验与失败原因');
  {
    const dir = fakeDir('库', {
      'A.md': '# A\n\n甲。\n',
      'StarNotes.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- A.md 900 640\n',
    });
    const w = await openWith(dir);
    const d = w.document;
    w.HTMLElement.prototype.setPointerCapture = () => {};
    w.HTMLElement.prototype.releasePointerCapture = () => {};

    /* 可编程的 fetch：按正则匹配路径返回假响应 */
    let calls = [];
    let routes = [];
    const setRoutes = (...r) => { routes = r; calls = []; };
    w.fetch = async (url) => {
      const p = String(url).replace('https://api.github.com', '');
      calls.push(p);
      for (const r of routes) {
        if (!r.re.test(p)) continue;
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: { get: (k) => (k.toLowerCase() === 'x-ratelimit-remaining' ? String(r.rate ?? '4999') : null) },
          json: async () => (typeof r.body === 'function' ? r.body() : r.body),
        };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
    };

    const cfg = (o) => Object.assign({
      repo: 'R7000/starnote', branch: 'main', token: 'github_pat_11TESTTEST',
      author: '张三', email: 'me@example.com',
    }, o);

    // ---- 地址解析 ----
    ok(w.GH.parseRepo('https://github.com/R7000/starnote.git').repo === 'starnote', '认 https 地址 + .git');
    ok(w.GH.parseRepo('git@github.com:R7000/starnote.git').owner === 'R7000', '认 SSH 地址');
    ok(w.GH.parseRepo('R7000/starnote').owner === 'R7000', '认 owner/repo 简写');
    const treeUrl = w.GH.parseRepo('https://github.com/R7000/starnote/tree/main?tab=readme');
    ok(treeUrl.repo === 'starnote' && treeUrl.extra === 'tree/main', '多余路径被忽略、只取前两段', JSON.stringify(treeUrl));
    ok(!w.GH.parseRepo('https://gitlab.com/a/b').owner, '非 github 域名直接拒绝');
    ok(w.GH.parseRepo('https://gitlab.com/a/b').reason.includes('github.com'), '并说明只支持 github.com');
    ok(!w.GH.parseRepo('随便写的').owner, '不成形的地址直接拒绝');

    // ---- 本地字段校验：一个请求都不该发 ----
    setRoutes();
    ok((await w.GH.verify(cfg({ repo: '' }))).reason.includes('还没填仓库地址'), '空仓库地址被拦下');
    ok((await w.GH.verify(cfg({ repo: '糊里糊涂' }))).reason.includes('看不懂'), '地址看不懂时给出示例');
    ok((await w.GH.verify(cfg({ branch: ' ' }))).reason.includes('分支名'), '空分支被拦下');
    ok((await w.GH.verify(cfg({ token: '' }))).reason.includes('还没填 Token'), '空 Token 被拦下');
    ok((await w.GH.verify(cfg({ token: 'abc def' }))).reason.includes('空格'), 'Token 里有空白会被指出');
    ok((await w.GH.verify(cfg({ author: '' }))).reason.includes('作者名'), '空作者名被拦下');
    ok((await w.GH.verify(cfg({ email: 'nope' }))).reason.includes('邮箱'), '邮箱格式错被拦下');
    ok(calls.length === 0, '本地就能判断的问题不发请求', calls.length);

    // ---- 401 ----
    setRoutes({ re: /^\/user$/, status: 401, body: { message: 'Bad credentials' } });
    let r = await w.GH.verify(cfg());
    ok(!r.ok && r.reason.includes('Token 无效或已过期'), '401 → 说 Token 无效或过期', r.reason);
    ok(!!r.hint && r.hint.includes('Contents'), '附带该给什么权限', r.hint);

    // ---- 403 限流 ----
    setRoutes({ re: /^\/user$/, status: 403, rate: 0, body: { message: 'API rate limit exceeded' } });
    r = await w.GH.verify(cfg());
    ok(!r.ok && r.reason.includes('限流'), '403 + 剩余 0 → 判定为限流', r.reason);

    // ---- 网络不通 ----
    const realFetch = w.fetch;
    w.fetch = async () => { throw new TypeError('Failed to fetch'); };
    r = await w.GH.verify(cfg());
    ok(!r.ok && r.reason.includes('连不上'), 'fetch 抛错 → 提示连不上 API', r.reason);
    w.fetch = realFetch;

    // ---- 仓库 404 ----
    setRoutes(
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } },
      { re: /^\/repos\/R7000\/starnote$/, status: 404, body: { message: 'Not Found' } },
    );
    r = await w.GH.verify(cfg());
    ok(!r.ok && r.reason.includes('找不到这个仓库'), '仓库 404 → 找不到', r.reason);
    ok(r.hint.includes('Repository access'), '提示 fine-grained token 要授权该仓库', r.hint);

    // ---- 用户在这个仓库上没有写权限（和「token 只读」是两回事） ----
    setRoutes(
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } },
      { re: /^\/repos\/R7000\/starnote$/, status: 200, body: { permissions: { push: false, pull: true }, archived: false } },
    );
    r = await w.GH.verify(cfg());
    ok(!r.ok && r.reason.includes('没有写权限'), 'push:false → 说人在这个仓库上没有写权限', r.reason);
    ok(r.hint.includes('Write'), '提示找人给 Write 权限，而不是让他改 token');
    ok(calls.length === 2, '这一步不该再发写探测（已经知道写不了）', calls.join(','));

    // ---- 分支不存在 ----
    setRoutes(
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } },
      { re: /^\/repos\/R7000\/starnote$/, status: 200, body: { permissions: { push: true }, archived: false } },
      { re: /^\/repos\/R7000\/starnote\/git\/ref\/heads\//, status: 404, body: { message: 'Not Found' } },
      { re: /^\/repos\/R7000\/starnote\/git\/refs\/heads/, status: 200, body: [{ ref: 'refs/heads/main' }, { ref: 'refs/heads/develop' }] },
    );
    r = await w.GH.verify(cfg({ branch: 'trunk' }));
    ok(!r.ok && r.reason.includes('trunk'), '分支 404 → 指出这个分支不存在', r.reason);
    ok(r.hint.includes('main') && r.hint.includes('develop'), '把现有分支列出来', r.hint);

    // ---- 空仓库 ----
    setRoutes(
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } },
      { re: /^\/repos\/R7000\/starnote$/, status: 200, body: { permissions: { push: true }, archived: false } },
      { re: /^\/repos\/R7000\/starnote\/git\/ref\/heads\//, status: 404, body: { message: 'Not Found' } },
      { re: /^\/repos\/R7000\/starnote\/git\/refs\/heads/, status: 200, body: [] },
    );
    r = await w.GH.verify(cfg());
    ok(r.ok && r.info.empty === true, '空仓库允许绑定，并标记为「还没有提交」', JSON.stringify(r.info || r.reason));

    // ---- 一路通过 ----
    const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
    setRoutes(
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } },
      { re: /^\/repos\/R7000\/starnote$/, status: 200, body: { permissions: { push: true }, archived: false, private: true } },
      { re: /^\/repos\/R7000\/starnote\/git\/ref\/heads\//, status: 200, body: { object: { sha: SHA } } },
    );
    r = await w.GH.verify(cfg());
    ok(r.ok && r.info.login === 'R7000' && r.info.commit === SHA, '全部通过时带回账号与 commit', JSON.stringify(r.info));

    // ---- UI 全流程 ----
    const btn = d.getElementById('btnGH');
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    ok(d.getElementById('ghMask').hidden === false, '点顶栏 GitHub 按钮弹出面板');

    // 面板开着时，键盘不该穿透到画布（Del 不能删背后的笔记）
    tap(w, byTitle(w, 'A'));
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await sleep(60);
    ok(dir.has('A.md') === true && titled(w) === 'A', '面板开着时 Del 不会删背后的笔记', titled(w));

    d.getElementById('ghRepo').value = 'https://github.com/R7000/starnote';
    d.getElementById('ghBranch').value = 'main';
    d.getElementById('ghToken').value = 'github_pat_11TESTTEST';
    d.getElementById('ghName').value = '张三';
    d.getElementById('ghMail').value = 'me@example.com';
    setRoutes(
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } },
      { re: /^\/repos\/R7000\/starnote$/, status: 200, body: { permissions: { push: true }, archived: false } },
      { re: /^\/repos\/R7000\/starnote\/git\/ref\/heads\//, status: 200, body: { object: { sha: SHA } } },
    );
    d.getElementById('ghSubmit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(220);

    const st = d.getElementById('ghStatus');
    ok(st.classList.contains('good'), '校验通过 → 绿色成功状态', st.className);
    ok(/绑定成功/.test(st.textContent) && /R7000\/starnote/.test(st.textContent), '成功状态写明绑到了哪里', st.textContent);
    ok(btn.classList.contains('bound') && /R7000\/starnote/.test(btn.textContent), '顶栏按钮变成仓库名并进入已绑定态', btn.textContent);
    const saved = w.GH.current();
    ok(!!saved && saved.owner === 'R7000' && saved.branch === 'main' && saved.email === 'me@example.com', '仓库/分支/作者/邮箱都存下了', JSON.stringify(saved));
    ok(saved && saved.login === 'R7000' && saved.commit === SHA, '顺带记下了账号与当前 commit');
    ok(!/github_pat_11TESTTEST/.test(JSON.stringify(w.GH.maskToken(saved.token))), '打码后的 token 不泄露全文', w.GH.maskToken(saved.token));

    await sleep(1200);   // 成功后会自己关掉面板
    ok(d.getElementById('ghMask').hidden === true, '成功后面板自动收起');

    // ---- 再次打开后校验失败：不能把已有绑定弄丢 ----
    w.GH.open();
    await sleep(40);
    ok(d.getElementById('ghToken').value === 'github_pat_11TESTTEST', '重新打开时回填已保存的信息');
    setRoutes({ re: /^\/user$/, status: 401, body: { message: 'Bad credentials' } });
    d.getElementById('ghSubmit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(180);
    ok(st.classList.contains('bad'), '失败时状态条变红', st.className);
    ok(/Token 无效或已过期/.test(st.textContent), '红条上写明原因', st.textContent);
    ok(btn.classList.contains('bound') && w.GH.current() !== null, '校验失败不影响原来的绑定');

    // ---- 解除绑定 ----
    d.getElementById('ghUnbind').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(150);
    ok(w.GH.current() === null, '解除后本地不留绑定');
    ok(!btn.classList.contains('bound') && btn.textContent.trim() === 'GitHub', '按钮回到未绑定状态', btn.textContent);

    w.close();
  }

  console.log('\n[18] Token 过期：检测、顶栏提醒、引导更新');
  {
    const DAY = 864e5;
    const ghTime = (ts) => {
      const t = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) + ' ' +
        p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds()) + ' UTC';
    };

    const dir = fakeDir('库', {
      'A.md': '# A\n\n甲。\n',
      'StarNotes.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- A.md 900 640\n',
    });
    const w = await openWith(dir);
    const d = w.document;
    w.HTMLElement.prototype.setPointerCapture = () => {};
    w.HTMLElement.prototype.releasePointerCapture = () => {};

    let calls = [];
    let routes = [];
    const setRoutes = (...r) => { routes = r; calls = []; };
    w.fetch = async (url) => {
      const p = String(url).replace('https://api.github.com', '');
      calls.push(p);
      for (const r of routes) {
        if (!r.re.test(p)) continue;
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: {
            get: (k) => {
              const n = String(k).toLowerCase();
              if (n === 'x-ratelimit-remaining') return String(r.rate ?? '4999');
              if (n === 'github-authentication-token-expiration') return r.exp || null;
              return null;
            },
          },
          json: async () => (typeof r.body === 'function' ? r.body() : r.body),
        };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
    };

    /* ---- 到期头解析：两种写法都要认 ---- */
    ok(w.GH.parseExpiry('2027-02-13 10:00:00 UTC') === Date.UTC(2027, 1, 13, 10, 0, 0), '认 classic 的 UTC 写法');
    ok(w.GH.parseExpiry('2027-02-13 10:00:00 +0100') === Date.UTC(2027, 1, 13, 9, 0, 0), '认 fine-grained 的 +0100 写法');
    ok(w.GH.parseExpiry('2027-02-13T10:00:00Z') === Date.UTC(2027, 1, 13, 10, 0, 0), '也认 ISO 写法');
    ok(w.GH.parseExpiry('') === null && w.GH.parseExpiry('过两天') === null, '读不懂就返回 null');

    const soon = Math.floor((Date.now() + 3 * DAY) / 1000) * 1000;
    const okRoutes = (exp) => [
      { re: /^\/user$/, status: 200, body: { login: 'R7000' }, exp },
      { re: /^\/repos\/R7000\/starnote$/, status: 200, body: { permissions: { push: true }, archived: false } },
      { re: /^\/repos\/R7000\/starnote\/git\/ref\/heads\//, status: 200, body: { object: { sha: 'a'.repeat(40) } } },
    ];
    const cfg = {
      repo: 'R7000/starnote', branch: 'main', token: 'github_pat_11NEW',
      author: '张三', email: 'me@example.com',
    };

    setRoutes(...okRoutes(ghTime(soon)));
    let r = await w.GH.verify(cfg);
    ok(r.ok && Math.abs(r.info.expiresAt - soon) < 1500, '校验通过时把到期时间带回来', String(r.info.expiresAt));

    // 已知 bug：fine-grained token 有时把头填成「服务器当前时间」
    setRoutes(...okRoutes(ghTime(Date.now())));
    r = await w.GH.verify(cfg);
    ok(r.ok && r.info.expiresAt === null, '头里是「此刻」时不采信，避免天天误报过期', String(r.info.expiresAt));

    /* ---- 绑定一个 3 天后到期的 token ---- */
    const btn = d.getElementById('btnGH');
    const st = d.getElementById('ghStatus');
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    d.getElementById('ghRepo').value = 'R7000/starnote';
    d.getElementById('ghBranch').value = 'main';
    d.getElementById('ghToken').value = 'github_pat_11NEW';
    d.getElementById('ghName').value = '张三';
    d.getElementById('ghMail').value = 'me@example.com';
    setRoutes(...okRoutes(ghTime(soon)));
    d.getElementById('ghSubmit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(240);

    ok(st.classList.contains('good') && /到期/.test(st.textContent), '成功提示里带上到期日', st.textContent);
    ok(btn.classList.contains('warn'), '只剩 3 天 → 顶栏按钮转黄预警', btn.className);
    ok(/还有 \d 天/.test(btn.title), '悬停说明还剩几天', btn.title);
    await sleep(1200);
    ok(d.getElementById('ghMask').hidden === true, '成功后面板照常自动收起');

    /* ---- 时间走过到期日：本地就能判死，不用等 401 ---- */
    const bind = w.GH.current();
    bind.expiresAt = Date.now() - DAY;
    setRoutes({ re: /^\/rate_limit$/, status: 401, body: { message: 'Bad credentials' } });
    w.GH.open();
    await sleep(80);

    ok(btn.classList.contains('stale') && /Token 已过期/.test(btn.textContent), '过期后顶栏直接写「Token 已过期」', btn.textContent);
    ok(st.classList.contains('bad') && /已于/.test(st.textContent) && /过期/.test(st.textContent), '面板里说清是哪天过的期', st.textContent);
    ok(/其他字段不用改/.test(st.textContent), '告诉用户只要换 token，不必重填', st.textContent);
    ok(d.activeElement === d.getElementById('ghToken'), '光标自动落到 Token 那一格', d.activeElement && d.activeElement.id);

    /* ---- 静默复检只打免费端点（后面那次 /repos 是同步比对，不是校验） ---- */
    ok(calls[0] === '/rate_limit', '点开面板先用免费端点复检 token', calls.join(','));
    ok(!calls.includes('/user'), '复检不重复跑完整的 /user 校验', calls.join(','));

    /* ---- 没到期却被拒 = 被删除/重置 ---- */
    bind.expiresAt = Date.now() + 30 * DAY;
    setRoutes({ re: /^\/rate_limit$/, status: 401, body: { message: 'Bad credentials' } });
    await w.GH.watch(true);
    ok(btn.classList.contains('stale') && /已失效/.test(btn.textContent), '未到期却被拒 → 判定为被删除或重置', btn.textContent);
    ok(/删除|重置/.test(btn.title), '悬停说明可能的原因', btn.title);

    /* ---- 6 小时内不重复问 ---- */
    calls = [];
    await w.GH.watch(false);
    ok(calls.length === 0, '6 小时内不重复探测', String(calls.length));

    /* ---- 断网不能冤枉 token ---- */
    bind.stale = false;
    bind.staleReason = null;
    const realFetch = w.fetch;
    w.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await w.GH.watch(true);
    ok(bind.stale === false, '断网时不会把 token 判成失效');
    w.fetch = realFetch;

    /* ---- 401 的两级文案 ---- */
    bind.expiresAt = Date.now() - DAY;
    setRoutes({ re: /^\/user$/, status: 401, body: { message: 'Bad credentials' } });
    r = await w.GH.verify(cfg);
    ok(!r.ok && /已于/.test(r.reason) && /过期/.test(r.reason), '已过期 → 直接说「已于 … 过期」', r.reason);
    ok(/其他字段不用改/.test(r.hint), '并说明只需换 token', r.hint);

    bind.expiresAt = Date.now() + 30 * DAY;
    r = await w.GH.verify(cfg);
    ok(!r.ok && /401/.test(r.reason), '没到期却被拒 → 另给一句解释', r.reason);
    ok(/删除|重置/.test(r.hint), '并指向「被删了/被重置了」', r.hint);

    /* ---- 换上新 token，一切复位 ---- */
    const fresh = Date.now() + 100 * DAY;
    setRoutes(...okRoutes(ghTime(fresh)));
    d.getElementById('ghToken').value = 'github_pat_11FIXED';
    d.getElementById('ghSubmit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(240);

    ok(st.classList.contains('good'), '换上新 token 后校验通过', st.textContent);
    ok(!btn.classList.contains('stale') && !btn.classList.contains('warn'), '红黄告警同时消失', btn.className);
    ok(/R7000\/starnote/.test(btn.textContent), '按钮回到仓库名', btn.textContent);
    ok(w.GH.current().stale === false, '失效标记被清掉');
    ok(w.GH.current().expiresAt > Date.now() + 90 * DAY, '新的到期日被记住', String(w.GH.current().expiresAt));

    w.close();
  }

  console.log('\n[19] 网络抖动：自动重试、人话文案、分支降级');
  {
    const dir = fakeDir('库', {
      'A.md': '# A\n\n甲。\n',
      'StarNotes.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- A.md 900 640\n',
    });
    const w = await openWith(dir);
    const d = w.document;
    w.HTMLElement.prototype.setPointerCapture = () => {};
    w.HTMLElement.prototype.releasePointerCapture = () => {};

    const SHA = 'f'.repeat(40);
    let calls = [];
    let routes = [];
    let flaky = new Map();     // 路径 → 还要故意抛几次
    let down = new Set();      // 这些路径一直连不上
    const setRoutes = (...r) => { routes = r; calls = []; };

    w.fetch = async (url) => {
      const p = String(url).replace('https://api.github.com', '');
      calls.push(p);
      if (down.has(p)) throw new TypeError('Failed to fetch');
      const n = flaky.get(p) || 0;
      if (n > 0) { flaky.set(p, n - 1); throw new TypeError('Failed to fetch'); }
      for (const r of routes) {
        if (!r.re.test(p)) continue;
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: { get: (k) => (String(k).toLowerCase() === 'x-ratelimit-remaining' ? String(r.rate ?? '4999') : null) },
          json: async () => (typeof r.body === 'function' ? r.body() : r.body),
        };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
    };

    const okAll = () => [
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } },
      { re: /^\/repos\/R7000\/starnote$/, status: 200, body: { permissions: { push: true }, archived: false } },
      // 写权限探测：真的 POST 一个 blob。放在 ref 前面也没关系，两者路径不重叠
      { re: /^\/repos\/R7000\/starnote\/git\/blobs$/, status: 201, body: { sha: 'probe0000' } },
      { re: /^\/repos\/R7000\/starnote\/git\/ref\/heads\//, status: 200, body: { object: { sha: SHA } } },
    ];
    const cfg = {
      repo: 'R7000/starnote', branch: 'main', token: 'github_pat_11NET',
      author: '张三', email: 'me@example.com',
    };

    /* ---- 4xx 不该重试 ---- */
    setRoutes({ re: /^\/user$/, status: 401, body: { message: 'Bad credentials' } });
    await w.GH.verify(cfg);
    ok(calls.length === 1, '401 只问一次（重试也没用）', calls.join(','));

    /* ---- 5xx 重试一次 ---- */
    setRoutes({ re: /^\/user$/, status: 502, body: { message: 'Bad Gateway' } });
    let r = await w.GH.verify(cfg);
    ok(calls.length === 2, '502 会自动重试一次', calls.join(','));
    ok(/HTTP 502/.test(r.reason), '还失败就把状态码说出来', r.reason);

    /* ---- 抖一下能自愈 ---- */
    setRoutes(...okAll());
    flaky.set('/repos/R7000/starnote/git/ref/heads/main', 1);
    r = await w.GH.verify(cfg);
    ok(r.ok && r.info.commit === SHA, '第 4 步断一次，重试后照样通过', JSON.stringify(r.info || r.reason));
    ok(calls.filter((c) => c === '/repos/R7000/starnote/git/ref/heads/main').length === 2, '确实是重发了一次', calls.join(','));

    /* ---- 第 3 步彻底连不上：文案必须是人话 ---- */
    down = new Set(['/repos/R7000/starnote']);
    setRoutes(...okAll());
    r = await w.GH.verify(cfg);
    ok(!r.ok && /连不上 api\.github\.com/.test(r.reason), '连不上时点名是哪个请求', r.reason);
    ok(r.reason.includes('/repos/R7000/starnote'), '把端点写出来，便于判断是不是代理拦的', r.reason);
    ok(!/HTTP 0/.test(r.reason + r.hint), '不再把裸的 HTTP 0 丢给用户', r.reason);
    ok(/再试一次|重试/.test(r.hint), '告诉用户点按钮就是重试', r.hint);
    ok(/自动重试了 1 次/.test(r.hint), '并说明已经自动重试过', r.hint);

    /* ---- 第 4 步彻底连不上：降级为「已绑定，分支待确认」 ---- */
    down = new Set(['/repos/R7000/starnote/git/ref/heads/main']);
    setRoutes(...okAll());
    r = await w.GH.verify(cfg);
    ok(r.ok === true && r.info.branchUnchecked === true, '分支查不到不阻塞绑定', JSON.stringify(r.info || r.reason));
    ok(!!r.soft && /超时|连不上/.test(r.soft.reason), '带回一条软失败说明', r.soft && r.soft.reason);

    /* ---- 同样的降级在界面上是黄条，不是绿条也不是红条 ---- */
    const btn = d.getElementById('btnGH');
    const st = d.getElementById('ghStatus');
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    d.getElementById('ghRepo').value = 'R7000/starnote';
    d.getElementById('ghBranch').value = 'main';
    d.getElementById('ghToken').value = 'github_pat_11NET';
    d.getElementById('ghName').value = '张三';
    d.getElementById('ghMail').value = 'me@example.com';
    setRoutes(...okAll());
    d.getElementById('ghSubmit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(900);

    ok(st.classList.contains('warn'), '降级绑定显示黄条', st.className);
    ok(/没能确认/.test(st.textContent) && /main/.test(st.textContent), '黄条说清是哪一步、哪个分支', st.textContent);
    ok(!/HTTP 0/.test(st.textContent), '界面上也不出现 HTTP 0', st.textContent);
    ok(btn.classList.contains('bound'), '照样算绑上，按钮变仓库名', btn.textContent);
    ok(w.GH.current() && w.GH.current().branchUnchecked === true, '「分支未确认」记进绑定信息');
    await sleep(1300);
    ok(d.getElementById('ghMask').hidden === false, '软成功不自动收起，让人看见黄条');

    /* ---- 再点开还提醒 ---- */
    w.GH.close();
    w.GH.open();
    await sleep(80);
    ok(st.classList.contains('warn') && /分支/.test(st.textContent), '下次打开面板仍然提醒分支没确认', st.textContent);

    /* ---- 网络好了，补上确认 ---- */
    down = new Set();
    setRoutes(...okAll());
    d.getElementById('ghSubmit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(300);
    ok(st.classList.contains('good'), '补校验通过 → 绿条', st.textContent);
    ok(w.GH.current().branchUnchecked === false, '「分支未确认」标记被清掉');

    /* ---- 进度回调按顺序报四步（写权限是这版新加的） ---- */
    const seen = [];
    setRoutes(...okAll());
    await w.GH.verify(cfg, (k, s) => seen.push(k + ':' + s));
    ok(seen.join(',') === 'user:run,user:ok,repo:run,repo:ok,write:run,write:ok,ref:run,ref:ok',
      '进度按顺序报 user/repo/write/ref', seen.join(','));

    /* ---- 路径守卫 ----
       曾经把分支请求写成 /git/ref/heads/main（漏了 /repos/{owner}/{repo}），
       GitHub 对 OPTIONS 预检回 404 且不带 allow-headers，浏览器直接抛
       Failed to fetch，被误判成「连不上网」。所以这里把形状钉死。 */
    setRoutes(...okAll());
    calls = [];
    await w.GH.verify(Object.assign({}, cfg, { branch: 'feature/x' }));
    ok(calls.includes('/repos/R7000/starnote/git/ref/heads/feature/x'), '分支名带斜杠时路径保留 / 且位置正确', calls.join(','));
    const bad = calls.filter((p) => !/^\/(user|rate_limit)$/.test(p) && !/^\/repos\/[^/]+\/[^/]+(\/|$)/.test(p));
    ok(bad.length === 0, '所有请求都挂在 /repos/{owner}/{repo} 或全局端点上', bad.join(','));

    w.close();
  }

  console.log('\n[20] 同步：比对 / 推送 / 拉取 / 恢复');
  {
    const OLD_A = '# A\n\n甲。\n';
    const NEW_A = '# A\n\n改写过的。\n';
    const ONLY_REMOTE = '# 远\n\n只在远端。\n';

    const dir = fakeDir('库', {
      'A.md': OLD_A,
      'C.md': '# C\r\n\r\n丙。\r\n',          // 故意存成 CRLF
      'StarNotes.canvas.md': '---\ntype: canvas\nversion: 2\n---\n\n- A.md 900 640\n- C.md 1200 640\n- 画布 900 400\n',
      '画布': { 'B.md': '# B\n\n乙。\n' },
    });
    const w = await openWith(dir);
    const d = w.document;

    let calls = [];
    let routes = [];
    let nBlob = 0;
    const setRoutes = (...r) => { routes = r; calls = []; nBlob = 0; };
    w.fetch = async (url, opt) => {
      const p = String(url).replace('https://api.github.com', '');
      const method = (opt && opt.method) || 'GET';
      calls.push({ method, path: p, body: opt && opt.body ? JSON.parse(opt.body) : null });
      for (const r of routes) {
        if (!r.re.test(p)) continue;
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: { get: () => null },
          json: async () => (typeof r.body === 'function' ? r.body() : r.body),
        };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
    };

    const P = '/repos/R7000/starnote';
    const rx = (s) => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const last = (m, suffix) => {
      const hit = calls.filter((c) => c.method === m && c.path.indexOf(suffix) >= 0).pop();
      return hit ? hit.body : null;
    };
    const treeRoute = (files) => ({
      re: rx(P + '/git/trees/TREE1'), status: 200,
      body: {
        tree: Object.entries(files).map(([p, t]) => ({ path: p, type: 'blob', sha: w.GH.blobSha(t) })),
        truncated: false,
      },
    });
    const blobGets = (files) => Object.entries(files).map(([p, t]) => ({
      re: rx(P + '/git/blobs/' + w.GH.blobSha(t)), status: 200,
      body: { content: Buffer.from(t, 'utf8').toString('base64'), encoding: 'base64' },
    }));
    const base = (files) => [
      { re: rx('/user'), status: 200, body: { login: 'R7000' } },
      { re: new RegExp('^' + P + '$'), status: 200, body: { permissions: { push: true }, archived: false } },
      { re: new RegExp('^' + P + '/git/ref/heads/main$'), status: 200, body: { object: { sha: 'HEAD1' } } },
      { re: rx(P + '/git/commits/HEAD1'), status: 200, body: { tree: { sha: 'TREE1' } } },
      treeRoute(files),
      ...blobGets(files),
      { re: new RegExp('^' + P + '/git/blobs$'), status: 201, body: () => ({ sha: 'NEW' + (++nBlob) }) },
      { re: new RegExp('^' + P + '/git/trees$'), status: 201, body: { sha: 'TREE2' } },
      { re: new RegExp('^' + P + '/git/commits$'), status: 201, body: { sha: 'C2' } },
      { re: new RegExp('^' + P + '/git/refs/heads/main$'), status: 200, body: {} },
      { re: new RegExp('^' + P + '/git/refs$'), status: 201, body: {} },
    ];

    // 远端：A 和本地一致、C 与本地 CRLF 版内容等价、外加一个只在远端的
    const remote1 = { 'A.md': OLD_A, 'C.md': '# C\n\n丙。\n', '远端.md': ONLY_REMOTE };
    setRoutes(...base(remote1));

    /* ---- 哪些文件归同步管 ---- */
    ok(w.GH.isManaged('a/b.md') === true, '.md 归同步管');
    ok(w.GH.isManaged('.git/config.md') === false, '隐藏目录不碰');
    ok(w.GH.isManaged('a/.hidden/b.md') === false, '路径里有隐藏段也不碰');
    ok(w.GH.isManaged('img.png') === false, '非 .md 不碰');
    ok(/^[0-9a-f]{40}$/.test(w.GH.blobSha('x')), 'blob sha 是 40 位十六进制');

    /* ---- 绑定（走 UI，和真人一样填表）---- */
    const setVal = (id, v) => { d.getElementById(id).value = v; };
    click(w, 'btnGH');
    await sleep(80);
    setVal('ghRepo', 'R7000/starnote');
    setVal('ghBranch', 'main');
    setVal('ghToken', 'github_pat_11TESTTEST');
    setVal('ghName', '张三');
    setVal('ghMail', 'me@example.com');
    click(w, 'ghSubmit');
    await sleep(250);
    ok(!!w.GH.current() && w.GH.current().owner === 'R7000', '绑定成功');

    /* ---- 比对 ---- */
    click(w, 'btnGH');                    // 重开面板 → 自动比一次
    await sleep(300);
    const res1 = w.GH.state();
    ok(!!res1 && !res1.error, '面板一打开就完成比对');
    const d1 = res1.diff;
    ok(d1.same.join(',') === 'A.md,C.md', '内容相同（CRLF 不算改动）', d1.same.join(','));
    ok(d1.local.sort().join(',') === ['StarNotes.canvas.md', '画布/B.md'].sort().join(','), '只在本地',
      d1.local.join(','));
    ok(d1.remote.join(',') === '远端.md', '只在远端', d1.remote.join(','));
    ok(d1.both.length === 0, '没有内容冲突');

    ok(d.getElementById('gsWho').textContent.includes('本地 4 篇'), '统计本地篇数',
      d.getElementById('gsWho').textContent);
    ok(d.getElementById('gsWho').textContent.includes('远端 3 篇'), '统计远端篇数');
    ok(/只在本地/.test(d.getElementById('gsDiff').innerHTML), '差异表列出「只在本地」');
    ok(/拉取会删掉/.test(d.getElementById('gsDiff').innerHTML), '并说明拉取会删掉它们');
    ok(d.getElementById('gsPush').disabled === false, '有差异时推送可点');
    ok(d.getElementById('gsKeepRow').hidden === false, '首次推送显示「保留远端」勾选框');
    ok(d.getElementById('gsKeep').checked === true, '且默认勾上（不删）');
    ok(res1.firstTime === true, '还没同步过，算首次');

    /* ---- 首次推送：不删远端多出来的 ---- */
    click(w, 'gsPush');
    await sleep(400);
    ok(last('PATCH', '/git/refs/heads/main').sha === 'C2', '最后一步是移动分支指针');
    const tree1 = last('POST', '/git/trees');
    ok(tree1.base_tree === 'TREE1', '用 base_tree 做增量');
    ok(tree1.tree.length === 2, '首次推送只上传本地独有的 2 个', JSON.stringify(tree1.tree));
    ok(tree1.tree.every((e) => e.sha && e.sha !== null), '没有删除项（勾了保留）');
    const cm1 = last('POST', '/git/commits');
    ok(cm1.parents[0] === 'HEAD1', '提交挂在原 head 上');
    ok(cm1.author.name === '张三' && cm1.author.email === 'me@example.com', '作者信息写进去了');
    ok(w.GH.current().syncedAt > 0, '记住「同步过」');
    ok(d.getElementById('gsKeepRow').hidden === true, '推送后不再是首次，勾选框收起');

    /* ---- 第二次推送：覆盖语义，删掉远端多出来的 ---- */
    click(w, 'gsPush');
    await sleep(400);
    const tree2 = last('POST', '/git/trees');
    const del = tree2.tree.filter((e) => e.sha === null).map((e) => e.path);
    ok(del.join(',') === '远端.md', '第二次推送删掉远端独有的那个', del.join(','));
    ok(w.GH.current().syncedCommit === 'C2', '记下同步到哪个提交');

    /* ---- 拉取：覆盖本地 ---- */
    const remote2 = { 'A.md': NEW_A, 'C.md': '# C\n\n丙。\n', '远.md': ONLY_REMOTE };
    setRoutes(...base(remote2));
    click(w, 'gsRefresh');
    await sleep(300);
    const res2 = w.GH.state();
    ok(res2.diff.both.join(',') === 'A.md', '识别出两边都改过的文件', res2.diff.both.join(','));
    ok(res2.diff.remote.join(',') === '远.md', '远端新增的会被拉下来');

    click(w, 'gsPull');
    await sleep(500);
    ok(await dir.read('A.md') === NEW_A, '本地内容被远端覆盖', JSON.stringify(await dir.read('A.md')));
    ok(dir.has('远.md') === true, '远端新文件写到了本地');
    ok(dir.has('画布') === false, '本地独有的画布被删掉（连同空文件夹）');
    const snaps = await w.GH.loadSnaps();
    ok(snaps.length === 1, '拉取前留了一份快照', snaps.length);
    ok(snaps[0].files.length === 4, '快照里是拉取前的 4 个文件', snaps[0].files.length);
    ok(titled(w).includes('远'), '画布上出现了新节点');

    /* ---- 恢复拉取前 ---- */
    click(w, 'gsUndo');
    await sleep(500);
    ok(await dir.read('A.md') === OLD_A, '内容恢复到拉取前', JSON.stringify(await dir.read('A.md')));
    ok(dir.has('远.md') === false, '拉取带来的文件被清掉');
    const sub = dir.childDir('画布');
    ok(!!sub && await sub.read('B.md') === '# B\n\n乙。\n', '被删掉的画布回来了');
    ok(!titled(w).includes('远'), '画布上也撤掉了');

    /* ---- 空仓库：分支还不存在，只能 POST /git/refs ---- */
    setRoutes(
      { re: rx('/user'), status: 200, body: { login: 'R7000' } },
      { re: new RegExp('^' + P + '$'), status: 200, body: { permissions: { push: true } } },
      { re: new RegExp('^' + P + '/git/ref/heads/main$'), status: 404, body: { message: 'Not Found' } },
      { re: new RegExp('^' + P + '/git/refs/heads'), status: 200, body: [] },
      { re: new RegExp('^' + P + '/git/blobs$'), status: 201, body: () => ({ sha: 'EB' + (++nBlob) }) },
      { re: new RegExp('^' + P + '/git/trees$'), status: 201, body: { sha: 'ET' } },
      { re: new RegExp('^' + P + '/git/commits$'), status: 201, body: { sha: 'EC' } },
      { re: new RegExp('^' + P + '/git/refs$'), status: 201, body: {} },
    );
    const resE = await w.GH.compare();
    ok(!resE.error && resE.st.empty === true, '空仓库不算比对失败', resE.error && resE.error.reason);
    ok(resE.diff.local.length === 4 && resE.diff.remote.length === 0, '本地 4 篇全算新增');
    const rE = await w.GH.doPush(resE, { keepRemote: false });
    ok(rE.ok === true && rE.commit === 'EC', '空仓库也能推送成功');
    const treeE = last('POST', '/git/trees');
    ok(!('base_tree' in treeE), '首个提交没有 base_tree');
    ok(last('POST', '/git/commits').parents.length === 0, '首个提交没有 parents');
    const refE = last('POST', '/git/refs');
    ok(refE && refE.ref === 'refs/heads/main' && refE.sha === 'EC', '用 POST /git/refs 建分支', JSON.stringify(refE));

    /* ---- 分支名写错：不能当成空仓库去建分支 ---- */
    setRoutes(
      { re: new RegExp('^' + P + '$'), status: 200, body: { permissions: { push: true } } },
      { re: new RegExp('^' + P + '/git/ref/heads/main$'), status: 404, body: { message: 'Not Found' } },
      { re: new RegExp('^' + P + '/git/refs/heads'), status: 200, body: [{ ref: 'refs/heads/master' }] },
    );
    const resB = await w.GH.compare();
    ok(!!resB.error && resB.error.reason.includes('不存在'), '分支名写错时说分支不存在', resB.error && resB.error.reason);
    ok(!!resB.error && resB.error.hint.includes('master'), '并列出仓库现有的分支', resB.error && resB.error.hint);

    /* ---- 比对失败要说得清 ---- */
    setRoutes({ re: rx('/user'), status: 200, body: { login: 'R7000' } },
      { re: new RegExp('^' + P + '$'), status: 404, body: { message: 'Not Found' } },
      { re: new RegExp('^' + P + '/git/ref/heads/main$'), status: 404, body: { message: 'Not Found' } });
    const res3 = await w.GH.compare();
    ok(!!res3.error && res3.error.reason.includes('找不到仓库'), '分支 404 时再确认仓库，不瞎猜',
      res3.error && res3.error.reason);

    w.close();
  }

  console.log('\n[21] 节点上显示文件名');
  {
    const w = await openWith(nestedVault());
    const d = w.document;
    const fileOf = (el) => el.querySelector('.node-file')?.textContent;

    // 笔记显示带 .md 的名字；画布的名字就是文件夹名、和标题永远一样，所以这一行留空
    ok(fileOf(byTitle(w, '根层笔记')) === '根层笔记.md', '笔记节点显示文件名（带 .md）', fileOf(byTitle(w, '根层笔记')));
    ok(fileOf(byTitle(w, '知识地图')) === '', '画布节点不重复显示名字（会 :empty 收掉那一行）', fileOf(byTitle(w, '知识地图')));
    ok(nodeTitles(w).includes('根层笔记'), '标题照旧显示，不是被文件名顶掉');

    // 标题里带非法字符：磁盘上会被洗成 -，两个都要露出来，用户才知道真名
    dbl(w, byTitle(w, '根层笔记'));
    await sleep(120);
    const t = d.getElementById('editTitle');
    t.value = '对比：A/B 两种方案';
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await sleep(200);
    const renamed = byTitle(w, '对比：A/B 两种方案');
    ok(!!renamed, '标题保留原字（含 : 和 /）', nodeTitles(w).join(','));
    ok(fileOf(renamed) === '对比：A-B 两种方案.md', '文件名行显示洗过之后的真实文件名', fileOf(renamed));

    // 重名：第二篇同名，磁盘上是 (2)，标题不带
    click(w, 'btnNewNote');
    await sleep(150);
    d.getElementById('editTitle').value = '对比：A/B 两种方案';
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await sleep(200);
    const files = nodes(w).filter((el) => el.style.display !== 'none').map(fileOf);
    ok(files.includes('对比：A-B 两种方案 (2).md'), '重名时文件名行带 (2)，标题不带', files.join(' | '));
    ok(nodeTitles(w).filter((x) => x === '对比：A/B 两种方案').length === 2, '两篇标题这时是一样的，只有文件名能区分');

    // 搜索也认文件名 —— 搜 (2) 能命中那篇
    const s = d.getElementById('search');
    s.value = '(2)';
    s.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(80);
    const lit = nodes(w).filter((el) => el.style.display !== 'none' && !el.classList.contains('dim'));
    ok(lit.length === 1 && fileOf(lit[0]).includes('(2)'), '搜索能按磁盘文件名命中', lit.length);
    s.value = '';
    s.dispatchEvent(new w.Event('input', { bubbles: true }));

    // hover 卡也写一遍文件名
    const hovered = nodes(w).find((el) => el.style.display !== 'none' && fileOf(el) === '对比：A-B 两种方案.md');
    hovered.dispatchEvent(new w.MouseEvent('mouseenter', { bubbles: false }));
    await sleep(500);
    ok(d.getElementById('hovercard').textContent.includes('对比：A-B 两种方案.md'), '悬停卡也显示文件名',
      d.getElementById('hovercard').textContent.slice(0, 60));

    // 布局尺寸：CSS 变量和 app.js 的 NH 是两处，漂了会让拖拽命中整体偏一半，写死一个守卫
    const cssH = Number(/--node-h:\s*(\d+)px/.exec(fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8'))[1]);
    const jsH = Number(/const NH = (\d+);/.exec(appSrc)[1]);
    ok(cssH === jsH, 'CSS 的 --node-h 与 app.js 的 NH 一致', cssH + ' vs ' + jsH);
    ok(cssH === 88, '节点高度是 88（标题两行 + 文件名 + 关联行）', cssH);

    w.close();
  }

  console.log('\n[22] 写权限探测与 403 诊断');
  {
    const dir = fakeDir('库', {
      'A.md': '# A\n\n甲。\n',
      'StarNotes.canvas.md': '---\ntype: canvas\nversion: 2\n---\n\n- A.md 900 640\n',
    });
    const w = await openWith(dir);
    const d = w.document;

    let calls = [];
    let routes = [];
    let nBlob = 0;
    const setRoutes = (...r) => { routes = r; calls = []; nBlob = 0; };
    w.fetch = async (url, opt) => {
      const p = String(url).replace('https://api.github.com', '');
      const method = (opt && opt.method) || 'GET';
      calls.push({ method, path: p, body: opt && opt.body ? JSON.parse(opt.body) : null });
      for (const r of routes) {
        if (!r.re.test(p)) continue;
        if (r.method && r.method !== method) continue;
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: { get: () => null },
          json: async () => (typeof r.body === 'function' ? r.body() : r.body),
        };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
    };

    const P = '/repos/R7000/starnote';
    const NO_SCOPE = 'Resource not accessible by personal access token';
    const cfg = () => ({
      repo: 'R7000/starnote', branch: 'main', token: 'github_pat_11RO',
      author: '张三', email: 'me@example.com',
    });
    const headOk = { re: new RegExp('^' + P + '/git/ref/heads/main$'), status: 200, body: { object: { sha: 'HEAD1' } } };
    const repoOk = { re: new RegExp('^' + P + '$'), status: 200, body: { permissions: { push: true }, archived: false } };
    const probe = (status, message) => ({
      re: new RegExp('^' + P + '/git/blobs$'), method: 'POST',
      status, body: status < 300 ? { sha: 'PROBESHA' } : { message },
    });

    /* ---- 只读 token：permissions.push 是 true，只有真写才会露馅 ---- */
    setRoutes({ re: /^\/user$/, status: 200, body: { login: 'R7000' } }, repoOk, probe(403, NO_SCOPE), headOk);
    let r = await w.GH.verify(cfg());
    ok(r.ok === true, '只读 token 不阻断绑定（读方向是通的，拉取能用）', JSON.stringify(r.info || r));
    ok(r.info.readonly === true, '但如实标成只读');
    const pq = calls.find((c) => c.method === 'POST' && /\/git\/blobs$/.test(c.path));
    ok(!!pq, '校验时真的发了一次写请求（只读的接口问不出 token 的写入范围）');
    ok(pq && pq.body.encoding === 'utf-8' && pq.body.content.length < 64,
      '探针内容很短（不拿用户笔记去试）', JSON.stringify(pq && pq.body));
    ok(pq && /^StarNotes write probe/.test(pq.body.content), '探针是固定文本：sha 固定 → 反复探测只有一个悬空对象');
    ok(calls.filter((c) => c.method === 'POST' && /\/git\/blobs$/.test(c.path)).length === 1, '只探一次');

    /* ---- 探测本身失败，不能当成只读 ---- */
    setRoutes({ re: /^\/user$/, status: 200, body: { login: 'R7000' } }, repoOk,
      { re: new RegExp('^' + P + '/git/blobs$'), method: 'POST', status: 404, body: { message: 'Not Found' } }, headOk);
    r = await w.GH.verify(cfg());
    ok(r.ok === true && r.info.readonly === false, '探针 404 ≠ 只读，不能误报', JSON.stringify(r.info && r.info.readonly));

    setRoutes({ re: /^\/user$/, status: 200, body: { login: 'R7000' } }, repoOk,
      { re: new RegExp('^' + P + '/git/blobs$'), method: 'POST', status: 502, body: { message: 'gateway' } },
      { re: new RegExp('^' + P + '/git/blobs$'), method: 'POST', status: 502, body: { message: 'gateway' } }, headOk);
    r = await w.GH.verify(cfg());
    ok(r.ok === true && r.info.readonly === false, '5xx 也只是「没测出来」，不判只读');

    /* ---- 可写：一切正常 ---- */
    setRoutes({ re: /^\/user$/, status: 200, body: { login: 'R7000' } }, repoOk, probe(201), headOk);
    r = await w.GH.verify(cfg());
    ok(r.ok === true && r.info.readonly === false, '可写时 readonly 是 false');

    /* ---- UI：只读绑定后的样子 ---- */
    const files = { 'A.md': '# A\n\n甲。\n', '远.md': '# 远\n\n只在远端。\n' };
    const syncRoutes = () => [
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } }, repoOk,
      probe(403, NO_SCOPE), headOk,
      { re: new RegExp('^' + P + '/git/commits/HEAD1$'), status: 200, body: { tree: { sha: 'TREE1' } } },
      {
        re: new RegExp('^' + P + '/git/trees/TREE1'), status: 200,
        body: { tree: Object.entries(files).map(([p, t]) => ({ path: p, type: 'blob', sha: w.GH.blobSha(t) })) },
      },
    ];
    setRoutes(...syncRoutes());
    d.getElementById('btnGH').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    d.getElementById('ghRepo').value = 'https://github.com/R7000/starnote';
    d.getElementById('ghBranch').value = 'main';
    d.getElementById('ghToken').value = 'github_pat_11RO';
    d.getElementById('ghName').value = '张三';
    d.getElementById('ghMail').value = 'me@example.com';
    d.getElementById('ghSubmit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(260);

    const st = d.getElementById('ghStatus');
    ok(st.classList.contains('warn'), '只读 → 黄条（不是红条：绑定本身是成功的）', st.className);
    ok(/只能读/.test(st.textContent), '黄条说清楚「这个 Token 只能读」', st.textContent.slice(0, 60));
    ok(/403/.test(st.textContent) || /拒绝/.test(st.textContent), '并说明推送会被拒，不是绑错了');
    ok(w.GH.current() && w.GH.current().readonly === true, 'readonly 存进了绑定');

    await sleep(1000);
    ok(d.getElementById('ghMask').hidden === false, '只读时不自动收起面板，让人看见这条提示');

    // 面板打开就比过一次；无论比对结果如何，推送按钮都该是灰的
    const push = d.getElementById('gsPush');
    ok(push.disabled === true, '推送按钮直接关掉，不用人点一次吃一次 403', push.disabled);
    ok(d.getElementById('gsDiff').innerHTML.includes('只能读'), '差异表最上面写明原因');

    /* ---- doPush 直测：403 的三种原因不能混成一句 ---- */
    const res = await w.GH.compare();
    ok(!res.error && res.diff && res.diff.local.length === 1, '比对出「StarNotes.canvas.md 只在本地」',
      JSON.stringify(res.diff && res.diff.local));

    setRoutes(...syncRoutes());
    let rr;
    try { rr = await w.GH.doPush(res, { keepRemote: true }); } catch (e) { rr = { ok: false, error: e.fail }; }
    ok(!rr.ok, '只读 token 推送必然失败');
    ok(/没有写权限/.test(rr.error.reason), '403 → 说 token 没有写权限', rr.error.reason);
    ok(!/StarNotes\.canvas\.md/.test(rr.error.reason),
      '不点名具体文件：整只 token 都不能写，报文件名会让人以为那个文件有问题', rr.error.reason);
    ok(/Read and write/.test(rr.error.hint) && /repo/.test(rr.error.hint),
      '把 fine-grained 和 classic 两种改法都说清楚', rr.error.hint);
    ok(/Contents/.test(rr.error.hint) && !/网络|代理/.test(rr.error.hint), '不会误导成网络问题');

    // 分支保护：blob/tree/commit 都过，倒在 PATCH ref 上
    setRoutes(
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } }, repoOk, probe(201), headOk,
      { re: new RegExp('^' + P + '/git/commits/HEAD1$'), status: 200, body: { tree: { sha: 'TREE1' } } },
      { re: new RegExp('^' + P + '/git/trees/TREE1'), status: 200, body: { tree: [] } },
      { re: new RegExp('^' + P + '/git/blobs$'), method: 'POST', status: 201, body: () => ({ sha: 'NEW' + (++nBlob) }) },
      { re: new RegExp('^' + P + '/git/trees$'), method: 'POST', status: 201, body: { sha: 'TREE2' } },
      { re: new RegExp('^' + P + '/git/commits$'), method: 'POST', status: 201, body: { sha: 'COMMIT2' } },
      { re: new RegExp('^' + P + '/git/refs/heads/main$'), method: 'PATCH', status: 403, body: { message: 'protected branch hook declined' } },
    );
    const rb0 = await w.GH.doPush(res, { keepRemote: true }).then((x) => x, (e) => ({ ok: false, error: e.fail }));
    const rb = rb0;
    ok(!rb.ok && /受保护/.test(rb.error.reason), 'PATCH 403 且 message 提到 protected branch → 说分支受保护', rb.error.reason);
    ok(/Branches|分支/.test(rb.error.hint), '并给出处理办法（放宽规则或换分支）', rb.error.hint);

    /* ---- 重新校验成可写后，只读标记要清掉 ---- */
    setRoutes(
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } }, repoOk, probe(201), headOk,
      { re: new RegExp('^' + P + '/git/commits/HEAD1$'), status: 200, body: { tree: { sha: 'TREE1' } } },
      { re: new RegExp('^' + P + '/git/trees/TREE1'), status: 200, body: { tree: [] } },
    );
    d.getElementById('ghToken').value = 'github_pat_11RW';
    d.getElementById('ghSubmit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(240);
    ok(w.GH.current() && w.GH.current().readonly === false, '换成可写 token 重新校验 → 只读标记清掉',
      JSON.stringify({ readonly: w.GH.current()?.readonly }));

    /* ---- 只读时点「比对」会重测：在 GitHub 上改完权限不用重填表单 ---- */
    const diffRoutes = (probeStatus) => [
      { re: /^\/user$/, status: 200, body: { login: 'R7000' } }, repoOk,
      probe(probeStatus, NO_SCOPE), headOk,
      { re: new RegExp('^' + P + '/git/commits/HEAD1$'), status: 200, body: { tree: { sha: 'TREE1' } } },
      { re: new RegExp('^' + P + '/git/trees/TREE1'), status: 200, body: { tree: [] } },
    ];

    setRoutes(...diffRoutes(403));
    d.getElementById('ghToken').value = 'github_pat_11RO3';
    d.getElementById('ghSubmit').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(280);
    ok(w.GH.current().readonly === true, '先绑成只读');
    ok(d.getElementById('gsPush').disabled === true, '推送灰掉');

    setRoutes(...diffRoutes(201));     // 相当于人刚在 GitHub 上把 Contents 改成了 Read and write
    await w.GH.refresh();
    ok(w.GH.current().readonly === false, '点「比对」就重新探测，发现已经可写');
    ok(d.getElementById('gsPush').disabled === false, '推送按钮随之恢复', d.getElementById('gsPush').disabled);

    /* ---- 已经确认可写之后不再重复探测（别每比一次就写一个探针） ---- */
    setRoutes(...diffRoutes(403));
    await w.GH.refresh();
    ok(w.GH.current().readonly === false, '确认可写后不再追问：降权只会在推送时暴露，这是有意的');

    w.close();
  }

  /* ============ 23. 外观主题 ============ */
  console.log('\n[23] 外观主题');
  {
    const cssRaw = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
    const blockRe = /^(:root|\[data-theme="[a-z]+"\])\s*\{[\s\S]*?\}/gm;

    function blockVars(sel) {
      const i = css.indexOf(sel + ' {');
      if (i < 0) return null;
      const a = css.indexOf('{', i), b = css.indexOf('}', a);
      const o = {};
      for (const m of css.slice(a + 1, b).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) o[m[1]] = m[2].trim();
      return o;
    }

    ok(/<script src="theme\.js"><\/script>/.test(html), 'index.html 引入了 theme.js');
    ok(html.indexOf('src="theme.js"') > html.indexOf('src="app.js"'), 'theme.js 排在 app.js 之后（先用它的工具，再挂自己的监听）');
    ok(/^\/\*[\s\S]*?\(function \(\) \{/.test(themeSrc.trim()), 'theme.js 是 IIFE：不会和 app.js 的顶层 const 撞车');
    ok(/localStorage\.getItem\('starnote\.theme'\)/.test(html), '首屏之前先把 data-theme 套上，不闪白底');

    /* ---- 主题与样式表对齐：加主题时最容易漏的就是这里 ---- */
    const ids = [...css.matchAll(/\[data-theme="([a-z]+)"\]\s*\{/g)].map((m) => m[1]);
    ok(ids.join(',') === 'sepia,night,forest', '三套非默认主题各有一个 CSS 块（默认纸白写在 :root）', ids.join(','));
    ok(/\[data-theme="night"\]\s*\{[\s\S]*?color-scheme:\s*dark/.test(css), '夜蓝声明 color-scheme: dark（原生控件、滚动条跟着变深）');

    const rootVars = blockVars(':root');
    const layoutOnly = ['--radius', '--node-w', '--node-h', '--font', '--mono'];
    for (const id of ids) {
      const v = blockVars('[data-theme="' + id + '"]');
      const short = Object.keys(rootVars).filter((k) => !layoutOnly.includes(k) && !v[k]);
      const extra = Object.keys(v).filter((k) => !rootVars[k]);
      ok(short.length === 0, id + ' 把 :root 的颜色变量补齐了（漏一个就有元素不跟着换）', short.join(','));
      ok(extra.length === 0, id + ' 没有 :root 不认识的野变量', extra.join(','));
    }
    /* 正文里不许有写死的颜色：漏掉一处，那处就不会跟着主题变 */
    const stray = css.replace(blockRe, '').match(/#[0-9a-fA-F]{3,8}\b/g);
    ok(!stray, '主题块之外没有写死的色值', stray && stray.join(','));

    /* ---- 面板与交互 ---- */
    const dir = nestedVault();
    const w = await openWith(dir);
    const d = w.document;
    const root = d.documentElement;

    ok(w.Theme.list.length === 4, '四套主题', w.Theme.list.length);
    ok(w.Theme.current() === 'paper', '默认纸白');
    ok(root.getAttribute('data-theme') === 'paper', '启动就套上 data-theme');
    ok(d.querySelectorAll('#thGrid .th-item').length === 4, '面板里四张卡片');
    ok(d.querySelectorAll('#thGrid .th-item.on').length === 1, '只有一张是选中态');

    /* 预览图的颜色必须就是那套主题的真实取值，否则「点了才发现不是这个色」 */
    let palOk = true, palBad = '';
    for (const t of w.Theme.list) {
      const v = t.id === 'paper' ? rootVars : blockVars('[data-theme="' + t.id + '"]');
      const hit = v['--bg'] === t.pal.bg && v['--surface'] === t.pal.surface && v['--line'] === t.pal.line &&
        v['--accent'] === t.pal.accent && v['--wire'] === t.pal.wire && v['--text-3'] === t.pal.dim;
      if (!hit) { palOk = false; palBad += t.id + ' '; }
    }
    ok(palOk, '卡片预览色 = CSS 里的实际取值', palBad);

    const mask = d.getElementById('thMask');
    ok(mask.hidden === true, '面板默认关着');
    click(w, 'btnTheme');
    ok(w.Theme.isOpen() && mask.hidden === false, '点顶栏「主题」打开面板');

    const night = d.querySelector('#thGrid .th-item[data-theme="night"]');
    night.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ok(root.getAttribute('data-theme') === 'night', '点卡片立刻换主题（不刷新）');
    ok(w.localStorage.getItem('starnote.theme') === 'night', '选择记在本机 localStorage');
    ok(night.classList.contains('on') && night.getAttribute('aria-pressed') === 'true', '选中态跟着走');
    ok(d.querySelectorAll('#thGrid .th-item.on').length === 1, '同时只有一张选中');
    ok(d.getElementById('thNote').textContent.includes('夜蓝'), '底部写清切到了哪套');

    ok(w.Theme.apply('nope') === 'paper', '未知主题名回退默认，不留下空主题');
    ok(root.getAttribute('data-theme') === 'paper', 'DOM 上也是纸白');

    /* 主题不碰笔记库：文件夹里一个文件都不该多 */
    const before = dir._handles.size;
    w.Theme.apply('forest');
    ok(dir._handles.size === before, '换主题不写任何文件进库');

    /* 三种关法 */
    click(w, 'thClose');
    ok(!w.Theme.isOpen(), '「完成」关闭');
    click(w, 'btnTheme');
    mask.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ok(!w.Theme.isOpen(), '点遮罩空白关闭');
    click(w, 'btnTheme');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(!w.Theme.isOpen(), 'Esc 关闭');

    /* 面板开着时，键盘不该漏到底下：Del 不能删笔记，Esc 不能清选择 */
    w.HTMLElement.prototype.setPointerCapture = () => {};
    const n0 = nodes(w)[0];
    n0.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
    w.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }));
    await sleep(30);
    const sel = d.querySelector('#nodeLayer .node.selected');
    ok(!!sel, '先选中一个节点（后面验证不会被误清）');
    click(w, 'btnTheme');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(!!d.querySelector('#nodeLayer .node.selected'), 'Esc 只关面板，不清背后的选择');
    click(w, 'btnTheme');
    const cnt = nodes(w).length;
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await sleep(60);
    ok(nodes(w).length === cnt, '面板开着按 Del 不会删掉背后的节点');
    w.Theme.close();

    /* 箭头与关系标签以前把颜色写死在 HTML/JS 里，换主题不会跟 */
    ok(!/fill="#[0-9a-fA-F]{6}"/.test(html), 'HTML 里不再写死箭头颜色');
    ok(/#arrow path \{ fill: var\(--wire\)/.test(css), '箭头填充改由 CSS 变量给');
    ok(appSrc.includes("'wire-label-bg'") && css.includes('.wire-label-bg'), '关系标签有底色了（以前 rect 吃 SVG 默认纯黑）');

    w.close();
  }

  console.log('\n[24] 提交历史：读历史 / 回退到某一版 / 可编辑提交信息');
  {
    const OLD_A = '# A\n\n甲。\n';
    const MID_A = '# A\n\n中间版。\n';
    const NEW_A = '# A\n\n最新版。\n';
    const REM_C = '# C\n\n远端的。\n';

    const dir = fakeDir('库', {
      'A.md': OLD_A,
      'B.md': '# B\n\n乙。\n',
      'StarNotes.canvas.md': '---\ntype: canvas\nversion: 2\n---\n\n- A.md 900 640\n- B.md 1200 640\n',
    });
    const w = await openWith(dir);
    const d = w.document;

    let calls = [];
    let routes = [];
    let nBlob = 0;
    const setRoutes = (...r) => { routes = r; calls = []; nBlob = 0; };
    w.fetch = async (url, opt) => {
      const p = String(url).replace('https://api.github.com', '');
      const method = (opt && opt.method) || 'GET';
      calls.push({ method, path: p, body: opt && opt.body ? JSON.parse(opt.body) : null });
      for (const r of routes) {
        if (!r.re.test(p)) continue;
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: { get: () => null },
          json: async () => (typeof r.body === 'function' ? r.body() : r.body),
        };
      }
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
    };

    const P = '/repos/R7000/starnote';
    const rx = (s) => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const last = (m, suffix) => {
      const hit = calls.filter((c) => c.method === m && c.path.indexOf(suffix) >= 0).pop();
      return hit ? hit.body : null;
    };

    const filesHEAD3 = { 'A.md': NEW_A, 'C.md': REM_C };
    const filesHEAD2 = { 'A.md': MID_A, 'C.md': REM_C, 'img.png': 'x', '.github/ci.md': 'y' };
    const filesHEAD1 = { 'A.md': '# A\n\n最初。\n' };

    const treeRoute = (sha, files) => ({
      re: rx(P + '/git/trees/' + sha), status: 200,
      body: {
        tree: Object.entries(files).map(([p, t]) => ({ path: p, type: 'blob', sha: w.GH.blobSha(t) })),
        truncated: false,
      },
    });
    const blobRoutes = (files) => Object.entries(files).map(([p, t]) => ({
      re: rx(P + '/git/blobs/' + w.GH.blobSha(t)), status: 200,
      body: { content: Buffer.from(t, 'utf8').toString('base64'), encoding: 'base64' },
    }));

    const commitsBody = [
      {
        sha: 'HEAD3',
        commit: { message: 'StarNotes: 同步笔记（+2 ~1 -1）\n\n· 新增 B.md', author: { name: '张三', date: '2026-11-15T12:00:00Z' } },
        parents: [{ sha: 'HEAD2' }],
      },
      {
        sha: 'HEAD2',
        commit: { message: '手改：整理第二节', author: { name: '张三', date: '2026-11-14T09:30:00Z' } },
        parents: [{ sha: 'HEAD1' }],
      },
      {
        sha: 'HEAD1',
        commit: { message: 'StarNotes: 初始化', author: { name: '李四', date: '2026-11-13T21:00:00Z' } },
        parents: [],
      },
    ];

    const base = () => [
      { re: rx('/user'), status: 200, body: { login: 'R7000' } },
      { re: new RegExp('^' + P + '$'), status: 200, body: { permissions: { push: true } } },
      { re: new RegExp('^' + P + '/git/ref/heads/main$'), status: 200, body: { object: { sha: 'HEAD3' } } },
      { re: new RegExp('^' + P + '/git/refs/heads/main$'), status: 200, body: {} },
      { re: new RegExp('^' + P + '/git/refs$'), status: 201, body: {} },
      { re: new RegExp('^' + P + '/git/commits/HEAD3$'), status: 200, body: { tree: { sha: 'TREE3' } } },
      { re: new RegExp('^' + P + '/git/commits/HEAD2$'), status: 200, body: { tree: { sha: 'TREE2' } } },
      { re: new RegExp('^' + P + '/git/commits/HEAD1$'), status: 200, body: { tree: { sha: 'TREE1' } } },
      treeRoute('TREE3', filesHEAD3),
      treeRoute('TREE2', filesHEAD2),
      treeRoute('TREE1', filesHEAD1),
      ...blobRoutes(filesHEAD3),
      ...blobRoutes(filesHEAD2),
      ...blobRoutes(filesHEAD1),
      { re: new RegExp('^' + P + '/git/blobs$'), status: 201, body: () => ({ sha: 'NB' + (++nBlob) }) },
      { re: new RegExp('^' + P + '/git/trees$'), status: 201, body: { sha: 'TREE4' } },
      { re: new RegExp('^' + P + '/git/commits$'), status: 201, body: { sha: 'C9' } },
      { re: new RegExp('^' + P + '/commits\\?'), status: 200, body: commitsBody },
    ];

    setRoutes(...base());

    /* ---- 先绑定 ---- */
    const setVal = (id, v) => { d.getElementById(id).value = v; };
    click(w, 'btnGH');
    await sleep(80);
    setVal('ghRepo', 'R7000/starnote');
    setVal('ghBranch', 'main');
    setVal('ghToken', 'github_pat_11TESTTEST');
    setVal('ghName', '张三');
    setVal('ghMail', 'me@example.com');
    click(w, 'ghSubmit');
    await sleep(300);
    ok(!!w.GH.current(), '绑定成功');
    ok(d.getElementById('gsHist').hidden === true, '历史面板默认收起');

    /* ---- 读提交历史 ---- */
    click(w, 'gsHistory');
    await sleep(320);
    ok(d.getElementById('gsHist').hidden === false, '点「历史」展开');
    ok(calls.some((c) => c.path.indexOf('/commits?sha=main&per_page=20&page=1') >= 0),
      '按当前分支读第一页 /commits', JSON.stringify(calls.map((c) => c.path)));
    const rows = [...d.querySelectorAll('#gsHistList .gs-commit')];
    ok(rows.length === 3, '列出 3 条提交', rows.length);
    ok(rows[0].querySelector('.gs-c-tag.head') && rows[0].querySelector('.gs-c-tag.head').textContent === '远端最新',
      '最新那条有「远端最新」标记');
    ok(/StarNotes: 同步笔记/.test(rows[0].textContent), '显示提交说明首行');
    ok(/张三/.test(rows[0].textContent) && /\d\d-\d\d \d\d:\d\d/.test(rows[0].textContent), '显示作者与时间',
      rows[0].querySelector('.gs-c-meta').textContent);
    ok(d.querySelectorAll('#gsHistList .gs-c-tag.mine').length === 1, 'StarNotes 自己提交的那条另有标记');
    ok(d.getElementById('gsRestore').disabled === true, '还没选就不让回退');
    ok(/选一版/.test(d.getElementById('gsHistSel').textContent), '底栏提示先选一版');

    /* ---- 选一版：先看和现在的差别 ---- */
    rows[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(300);
    const on = d.querySelector('#gsHistList .gs-commit.on');
    ok(!!on && on.getAttribute('data-i') === '1', '选中的那条高亮');
    ok(d.getElementById('gsRestore').disabled === false, '选完可以回退');
    const summ = d.getElementById('gsHistSel').textContent;
    ok(/新增 1/.test(summ) && /改写 1/.test(summ) && /本地多出 2/.test(summ), '摘要说清三类差异', summ);
    ok(calls.some((c) => c.path === P + '/git/commits/HEAD2'), '读数那一版时用的是 /git/commits/{sha}');

    /* ---- 回退：只改本地 ---- */
    click(w, 'gsRestore');
    await sleep(700);
    ok(await dir.read('A.md') === MID_A, '内容回退到那一版', JSON.stringify(await dir.read('A.md')));
    ok(dir.has('B.md') === false, '那一版里没有的笔记被删掉');
    const lay = await dir.read('StarNotes.canvas.md');
    ok(lay === null || !lay.includes('B.md'), '坐标文件按这一版重排，删掉的笔记不留坐标', JSON.stringify(lay));
    ok(dir.has('C.md') === true, '那一版才有的文件下载下来了');
    ok(await dir.read('C.md') === REM_C, '下载内容正确');
    ok(dir.has('img.png') === false && dir.has('.github') === false, '只碰 .md，图片与隐藏目录不跟着回来');
    ok(w.GH.current().restoredCommit === 'HEAD2', '记住回退到了哪一版');
    ok((await w.GH.loadSnaps()).length === 1, '回退前存了快照');
    ok(d.getElementById('ghStatus').textContent.includes('已回退到 HEAD2'), '状态栏说清回退到哪一版',
      d.getElementById('ghStatus').textContent);
    ok(d.getElementById('gsDiff').textContent.includes('远端最新还是'), '差异区提醒远端还没跟上');
    ok(!calls.some((c) => c.method === 'PATCH'), '回退不改分支指针');
    ok(!calls.some((c) => c.method === 'POST' && /\/git\/(commits|trees)$/.test(c.path)),
      '回退不往远端写提交', JSON.stringify(calls.filter((c) => c.method !== 'GET').map((c) => c.path)));

    /* ---- 恢复上一版：撤回这次回退 ---- */
    click(w, 'gsUndo');
    await sleep(700);
    ok(await dir.read('A.md') === OLD_A, '「恢复上一版」撤回了这次回退', JSON.stringify(await dir.read('A.md')));
    ok(dir.has('B.md') === true, '删掉的笔记回来了');
    ok(w.GH.current().restoredCommit === null, '恢复后不再标着「已回退」');

    /* ---- 提交信息：自动生成 + 手改不被覆盖 ---- */
    const msg = d.getElementById('gsMsg');
    ok(d.getElementById('gsMsgRow').hidden === false, '有改动时出现提交信息框');
    ok(/^StarNotes: 同步笔记（\+2 ~1 -1）/.test(msg.value), '按改动量自动生成说明', msg.value);
    ok(msg.value.includes('B.md') && msg.value.includes('A.md') && msg.value.includes('C.md'),
      '正文列出变动文件名', msg.value);
    ok(d.getElementById('gsMsgTip').textContent === '自动', '标记为「自动」');

    msg.value = '我手写的说明';
    msg.dispatchEvent(new w.Event('input', { bubbles: true }));
    ok(d.getElementById('gsMsgTip').textContent === '已手改', '手改后标记变化');
    click(w, 'gsRefresh');
    await sleep(320);
    ok(d.getElementById('gsMsg').value === '我手写的说明', '点「比对」不会冲掉手写的说明');

    click(w, 'gsMsgGen');
    await sleep(60);
    ok(/^StarNotes: 同步笔记（/.test(d.getElementById('gsMsg').value), '「重写」恢复自动生成');
    ok(d.getElementById('gsMsgTip').textContent === '自动', '标记也回到「自动」');

    /* ---- 推送带上手写的说明 ---- */
    d.getElementById('gsMsg').value = '整理第二节：重写 A，删掉 C';
    d.getElementById('gsMsg').dispatchEvent(new w.Event('input', { bubbles: true }));
    click(w, 'gsPush');
    await sleep(600);
    const cmPush = last('POST', '/git/commits');
    ok(cmPush && cmPush.message === '整理第二节：重写 A，删掉 C', '推送用的是手写的说明',
      cmPush && JSON.stringify(cmPush.message));

    /* 说明被清空时不能往 GitHub 推一条空提交信息 */
    d.getElementById('gsMsg').value = '   ';
    d.getElementById('gsMsg').dispatchEvent(new w.Event('input', { bubbles: true }));
    click(w, 'gsPush');
    await sleep(600);
    const cmEmpty = last('POST', '/git/commits');
    ok(cmEmpty && /^StarNotes: 同步笔记（/.test(cmEmpty.message), '说明清空时退回自动生成的一条',
      cmEmpty && JSON.stringify(cmEmpty.message));

    /* ---- 分页：还有更早的 ---- */
    const many = Array.from({ length: 20 }, (_, i) => ({
      sha: 'S' + i,
      commit: { message: '第 ' + i + ' 条', author: { name: '张三', date: '2026-11-01T00:00:00Z' } },
      parents: [],
    }));
    setRoutes(
      { re: new RegExp('^' + P + '/commits\\?sha=main&per_page=20&page=1$'), status: 200, body: many },
      { re: new RegExp('^' + P + '/commits\\?sha=main&per_page=20&page=2$'), status: 200, body: many.slice(0, 2) },
      ...base(),
    );
    click(w, 'gsHistory');           // 收起
    await sleep(120);
    click(w, 'gsHistory');           // 再打开 → 重读第一页
    await sleep(400);
    const more = d.getElementById('gsHistMore');
    ok(!!more, '还有更早的提交时给「加载更早」');
    ok(d.querySelectorAll('#gsHistList .gs-commit').length === 20, '第一页 20 条',
      d.querySelectorAll('#gsHistList .gs-commit').length);
    more.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(400);
    ok(calls.some((c) => c.path.indexOf('page=2') >= 0), '点它去读第二页',
      JSON.stringify(calls.map((c) => c.path)));
    ok(d.querySelectorAll('#gsHistList .gs-commit').length === 22, '两页拼在一起',
      d.querySelectorAll('#gsHistList .gs-commit').length);

    /* ---- 读历史失败 / 空仓库 ---- */
    setRoutes({ re: new RegExp('^' + P + '/commits\\?'), status: 500, body: { message: 'boom' } });
    click(w, 'gsHistReload');
    await sleep(2600);               // 5xx 会自动重试一次，等它把话说完
    ok(!!d.querySelector('#gsHistList .gs-err'), '读历史失败时显示错误，不是空白列表');

    setRoutes({ re: new RegExp('^' + P + '/commits\\?'), status: 409, body: { message: 'Git Repository is empty.' } });
    click(w, 'gsHistReload');
    await sleep(320);
    ok(d.getElementById('gsHistList').textContent.includes('还没有提交'), '空仓库给一句人话',
      d.getElementById('gsHistList').textContent);

    w.close();
  }

  console.log('\n[25] 顶栏「选择笔记目录」按钮：文案与当前目录名');
  {
    const dir = fakeDir('我的知识库', { 'A.md': '# A\n\n甲。\n' });
    const w = await openWith(dir);
    const d = w.document;
    const b = d.getElementById('btnOpen');
    ok(!!b, '顶栏上有这个按钮');
    ok(b.textContent.trim() === '选择笔记目录', '文案是「选择笔记目录」，不再叫「打开文件夹」', b.textContent);
    ok(/我的知识库/.test(b.title), 'title 里带着当前库名，误点前看得见', b.title);
    ok(!/打开文件夹/.test(d.body.innerHTML), '界面上不再出现「打开文件夹」这种像常用动作的说法');
    w.close();
  }

  console.log('\n[26] 改名兼容：老库的 StarNote.*.md 仍能读，写入迁到新名');
  {
    const box = (el) => ({ x: Math.round(parseFloat(el.style.left) + 84), y: Math.round(parseFloat(el.style.top) + 44) });
    const dir = fakeDir('旧库', {
      'A.md': '# A\n\n甲。\n',
      'B.md': '# B\n\n乙。\n',
      // 改名前的两张表：文件名是 StarNote.*，内容格式没变
      'StarNote.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- A.md 700 500\n- B.md 1000 500\n',
      'StarNote.graph.md': '---\ntype: starnote-graph\nversion: 1\n---\n\n## A.md\n- B.md | 属于 | →\n',
    });
    const w = await openWith(dir);
    const d = w.document;

    ok(nodeTitles(w).includes('A') && nodeTitles(w).includes('B'), '笔记照常读出来');
    ok(!nodeTitles(w).some((t) => /\.canvas|\.graph/.test(t)), '旧的两张表没被当成笔记画上板',
      nodeTitles(w).join(','));

    const a = byTitle(w, 'A');
    ok(a && box(a).x === 700 && box(a).y === 500, '旧文件里的坐标原样生效（不是重排过的）',
      a && JSON.stringify(box(a)));
    ok(d.getElementById('statLinks').textContent.startsWith('1'), '旧文件里的关系也读到了',
      d.getElementById('statLinks').textContent);

    // 迁移是 500ms 防抖写盘，等它落下去
    await sleep(700);
    ok(dir.has('StarNotes.canvas.md'), '打开老库后按新名补了一份坐标表');
    ok(dir.has('StarNotes.graph.md'), '关系表也迁到新名');
    ok(dir.has('StarNote.canvas.md'), '旧文件保留不删（用户可能还想看）');
    ok(/A\.md/.test(await dir.read('StarNotes.canvas.md')), '新表里有这一层的坐标',
      await dir.read('StarNotes.canvas.md'));
    w.close();
  }
  {
    // 两份都在时，新名优先——否则迁移后的库会被旧文件拽回去
    const dir = fakeDir('两份都有', {
      'A.md': '# A\n',
      'StarNotes.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- A.md 300 300\n',
      'StarNote.canvas.md': '---\ntype: starnote-canvas\nversion: 2\n---\n\n- A.md 900 900\n',
    });
    const w = await openWith(dir);
    const a = byTitle(w, 'A');
    ok(a && Math.round(parseFloat(a.style.left) + 84) === 300, '新旧两份同时存在时以新名为准',
      a && a.style.left);
    ok(!nodeTitles(w).some((t) => /\.canvas/.test(t)), '两份表都不上板');
    w.close();
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})();
