/* 外观主题：只换 style.css 里的那一层 CSS 变量，别的什么都不动。
   - 选择存在 localStorage('starnote.theme')：不进 IndexedDB、不写笔记库、不同步；
   - 首屏由 index.html <head> 里的小脚本先把 data-theme 套上，
     否则深色主题会先闪一帧纸白；
   - 这里只管三件事：卡片列表、点了立刻生效、读回来。

   必须写成 IIFE：app.js 是普通脚本，$ / state / esc 都在同一个全局词法环境里，
   这里再声明一次同名 const 会直接 SyntaxError。 */
(function () {
  'use strict';

  const KEY = 'starnote.theme';
  const DEFAULT = 'paper';

  /* id 必须和 style.css 里 [data-theme="id"] 一一对应；pal 是卡片上的小预览图，
     取值也得和 CSS 里那套主题一致 —— 两边不一致测试会报（免得预览和实际两个样）。 */
  const THEMES = [
    {
      id: 'paper', name: '纸白', tag: '默认',
      desc: '米白纸面 + 靛紫强调，最中性的一套',
      pal: { bg: '#f6f6f3', surface: '#ffffff', line: '#e5e4de', accent: '#534ab7', wire: '#c9c7da', dim: '#9a9890' },
    },
    {
      id: 'sepia', name: '暖纸', tag: '浅色',
      desc: '旧书页的暖调，长时间读不刺眼',
      pal: { bg: '#f2ebdf', surface: '#fbf6ec', line: '#e3d7c2', accent: '#a4562a', wire: '#d3c3a8', dim: '#9b8b71' },
    },
    {
      id: 'night', name: '夜蓝', tag: '深色',
      desc: '暗底浅字，晚上开着不烧眼',
      pal: { bg: '#12151c', surface: '#181c25', line: '#252b38', accent: '#8b8cf0', wire: '#3a4358', dim: '#767e91' },
    },
    {
      id: 'forest', name: '苔绿', tag: '浅色',
      desc: '冷调灰绿 + 墨绿强调，比纸白安静',
      pal: { bg: '#eef1ec', surface: '#fbfdf9', line: '#dfe5db', accent: '#1f7a5c', wire: '#c6d3c9', dim: '#8b988e' },
    },
  ];

  const $ = (s) => document.querySelector(s);
  const byId = (id) => THEMES.find((t) => t.id === id) || null;

  /* ---------------- 读写 ---------------- */

  function current() {
    let v = null;
    try { v = localStorage.getItem(KEY); } catch (e) { /* file:// 下可能禁 localStorage */ }
    return byId(v) ? v : DEFAULT;
  }

  /* 换主题不刷新页面：只改 <html data-theme>，CSS 变量自然全部重算 */
  function apply(id) {
    const th = byId(id) || byId(DEFAULT);
    document.documentElement.setAttribute('data-theme', th.id);
    try { localStorage.setItem(KEY, th.id); } catch (e) {}
    paint(th.id);
    return th.id;
  }

  /* ---------------- 卡片 ---------------- */

  /* 小预览图：一张画布的缩影 —— 点阵底、两个节点、一条连线、一条强调色标题条 */
  function preview(p) {
    const dots = [];
    for (let x = 10; x < 120; x += 16) {
      for (let y = 9; y < 62; y += 16) {
        dots.push('<circle cx="' + x + '" cy="' + y + '" r="0.9" fill="' + p.line + '"/>');
      }
    }
    return '<svg viewBox="0 0 120 62" role="presentation" aria-hidden="true" focusable="false">' +
        '<rect width="120" height="62" fill="' + p.bg + '"/>' + dots.join('') +
        '<path d="M46 28 Q60 34 74 38" fill="none" stroke="' + p.wire + '" stroke-width="1.6"/>' +
        '<rect x="12" y="16" width="34" height="24" rx="5" fill="' + p.surface + '" stroke="' + p.line + '"/>' +
        '<rect x="18" y="22" width="16" height="3" rx="1.5" fill="' + p.accent + '"/>' +
        '<rect x="18" y="29" width="22" height="2" rx="1" fill="' + p.dim + '" opacity=".65"/>' +
        '<rect x="74" y="26" width="34" height="24" rx="5" fill="' + p.surface + '" stroke="' + p.line + '"/>' +
        '<rect x="80" y="32" width="13" height="3" rx="1.5" fill="' + p.accent + '"/>' +
        '<rect x="80" y="39" width="20" height="2" rx="1" fill="' + p.dim + '" opacity=".65"/>' +
      '</svg>';
  }

  function render() {
    const grid = $('#thGrid');
    if (!grid) return;
    grid.innerHTML = THEMES.map((t) =>
      '<button type="button" class="th-item" data-theme="' + t.id + '" aria-pressed="false">' +
        '<span class="th-prev">' + preview(t.pal) + '</span>' +
        '<span class="th-cap"><b>' + t.name + '</b><i class="th-tag">' + t.tag + '</i></span>' +
        '<span class="th-sub">' + t.desc + '</span>' +
      '</button>').join('');
  }

  function paint(id) {
    const sel = byId(id) || byId(DEFAULT);
    const grid = $('#thGrid');
    if (grid) {
      for (const c of grid.querySelectorAll('.th-item')) {
        const on = c.dataset.theme === sel.id;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    const note = $('#thNote');
    if (note) note.textContent = '已切到「' + sel.name + '」· 只影响这台机器的显示，不写进笔记库。';
  }

  /* ---------------- 面板开关 ---------------- */

  const isOpen = () => {
    const m = $('#thMask');
    return !!m && !m.hidden;
  };

  let opener = null;

  function open() {
    const m = $('#thMask');
    if (!m) return;
    opener = document.activeElement;
    m.hidden = false;
    paint(current());
    const on = $('#thGrid .th-item.on') || $('#thGrid .th-item');
    if (on) on.focus();
  }

  function close() {
    const m = $('#thMask');
    if (!m || m.hidden) return;
    m.hidden = true;
    const back = opener && opener.focus ? opener : $('#btnTheme');
    if (back) back.focus();
    opener = null;
  }

  function wire() {
    for (const id of ['#btnTheme', '#gateTheme']) {
      const btn = $(id);
      if (btn) btn.addEventListener('click', open);
    }

    const done = $('#thClose');
    if (done) done.addEventListener('click', close);

    const mask = $('#thMask');
    if (mask) mask.addEventListener('click', (ev) => { if (ev.target === mask) close(); });

    const grid = $('#thGrid');
    if (grid) {
      grid.addEventListener('click', (ev) => {
        const card = ev.target.closest('.th-item');
        if (card) apply(card.dataset.theme);
      });
    }

    /* 捕获阶段拦 Esc：app.js 的 Esc 是「清空选择」，弹层开着时不该轮到它；
       两处都挂在 window 上，只有捕获阶段才保证先跑 */
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !isOpen()) return;
      ev.stopPropagation();
      close();
    }, true);
  }

  render();
  /* head 里的内联脚本已经把上次的选择套上了；万一没套上（CSP 拦了内联脚本之类），
     这里补一刀 —— 否则 <html> 上没有 data-theme，:root 的纸白就是兜底 */
  if (!document.documentElement.getAttribute('data-theme')) {
    document.documentElement.setAttribute('data-theme', current());
  }
  paint(current());
  wire();

  /* 给调试与测试用；界面本身不依赖这个 */
  window.Theme = {
    KEY,
    DEFAULT,
    list: THEMES,
    current,
    apply,
    open,
    close,
    isOpen,
    render,
  };
})();
