// 读者页：书架 → 书籍详情 → 分页阅读
import { $, esc, storageGet, storageSet } from './util.js';
import { normalizeLibrary, chapterPath, textToHtml, ui, tx, lang, setLang, statusLabel } from './lib.js';

const PROGRESS_KEY = 'arcadia-reader-progress';
const SETTINGS_KEY = 'arcadia-reader-settings';
const THEMES = ['white', 'paper', 'dark', 'green'];

let lib = null;
const textCache = new Map();
const settings = { size: 19, line: 1.9, theme: 'paper', font: 'serif', ...storageGet(SETTINGS_KEY, {}) };

// ---------------- 阅读进度 ----------------
const allProgress = () => storageGet(PROGRESS_KEY, {});
const getProgress = (nid) => allProgress()[nid] || null;
function saveProgress(nid, patch) {
  const all = allProgress();
  const cur = all[nid] || { read: [] };
  all[nid] = { ...cur, ...patch, time: Date.now() };
  storageSet(PROGRESS_KEY, all);
}

function bookPercent(novel, cid, frac) {
  const total = novel.chapters.reduce((s, c) => s + (c.chars || 1), 0) || 1;
  let before = 0;
  for (const c of novel.chapters) { if (c.id === cid) break; before += c.chars || 1; }
  const ch = novel.chapters.find(c => c.id === cid);
  return Math.min(100, Math.round(((before + (ch?.chars || 1) * (frac || 0)) / total) * 100));
}

// ---------------- 通用 ----------------
function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty('--r-size', settings.size + 'px');
  root.style.setProperty('--r-line', settings.line);
  root.dataset.font = settings.font;
}

function coverHtml(n, cls = '') {
  if (n.cover) return `<img class="cover ${cls}" src="${esc(n.cover)}" alt="${esc(tx(n, 'title'))}" loading="lazy">`;
  return `<div class="cover cover-blank ${cls}"><span>${esc(tx(n, 'title'))}</span><small>${esc(n.author || '')}</small></div>`;
}

const visibleNovels = () => lib.novels.filter(n => !n.hidden);
const findNovel = (id) => lib.novels.find(n => n.id === id);

function topbar(inner = '') {
  return `<header class="lib-top">
    <a href="#/" class="lib-brand">${esc(tx(lib.site, 'title'))}</a>${inner}
    <div class="lang-switch"><button data-lang="zh" class="${lang === 'zh' ? 'on' : ''}">中文</button><button data-lang="en" class="${lang === 'en' ? 'on' : ''}">EN</button></div>
  </header>`;
}

// ---------------- 书架 ----------------
function viewLibrary() {
  document.title = tx(lib.site, 'title');
  const cards = visibleNovels().map(n => {
    const pr = getProgress(n.id);
    const ch = pr && n.chapters.find(c => c.id === pr.cid);
    const pct = ch ? bookPercent(n, pr.cid, pr.frac) : 0;
    return `<a class="book-card" href="#/book/${esc(n.id)}">
      ${coverHtml(n)}
      <div class="book-info">
        <h3>${esc(tx(n, 'title'))}</h3>
        <div class="muted">${esc(n.author || '')} · ${esc(statusLabel(n.status))} · ${esc(ui('chapters', n.chapters.length))}</div>
        <p>${esc(tx(n, 'description').slice(0, 80))}</p>
        ${ch ? `<div class="bar"><span style="width:${pct}%"></span></div><small class="muted">${esc(ui('lastRead', ch.title))} · ${pct}%</small>` : ''}
      </div></a>`;
  }).join('');
  $('#app').innerHTML = `${topbar()}<main class="lib-main"><div class="book-grid">${cards || `<p class="muted">${esc(ui('empty'))}</p>`}</div></main>`;
}

// ---------------- 书籍详情 + 目录 ----------------
function tocHtml(n, currentCid) {
  const pr = getProgress(n.id);
  const read = new Set(pr?.read || []);
  let html = '', part = null;
  for (const c of n.chapters) {
    if (c.part && c.part !== part) { html += `<div class="toc-part">${esc(c.part)}</div>`; part = c.part; }
    const mark = c.id === (currentCid || pr?.cid) ? `<span class="tag now">${esc(ui('reading'))}</span>` : read.has(c.id) ? `<span class="tag">✓</span>` : '';
    html += `<a class="toc-ch ${c.id === currentCid ? 'on' : ''}" href="#/read/${esc(n.id)}/${esc(c.id)}">${esc(c.title)}${mark}</a>`;
  }
  return html || `<p class="muted">${esc(ui('noChapters'))}</p>`;
}

function viewBook(id) {
  const n = findNovel(id);
  if (!n || n.hidden) { $('#app').innerHTML = `${topbar()}<main class="lib-main"><p>${esc(ui('notFound'))}</p></main>`; return; }
  document.title = tx(n, 'title');
  const pr = getProgress(n.id);
  const ch = pr && n.chapters.find(c => c.id === pr.cid);
  const first = n.chapters[0];
  const btn = ch ? `<a class="btn primary" href="#/read/${esc(n.id)}/${esc(ch.id)}">${esc(ui('continue'))} · ${esc(ch.title)} · ${bookPercent(n, ch.id, pr.frac)}%</a>`
    : first ? `<a class="btn primary" href="#/read/${esc(n.id)}/${esc(first.id)}">${esc(ui('start'))}</a>` : '';
  const total = n.chapters.reduce((s, c) => s + (c.chars || 0), 0);
  $('#app').innerHTML = `${topbar()}<main class="lib-main">
    <section class="book-head">${coverHtml(n, 'big')}
      <div><h1>${esc(tx(n, 'title'))}</h1>
        <div class="muted">${esc(n.author || '')} · ${esc(statusLabel(n.status))} · ${esc(ui('chapters', n.chapters.length))} · ${esc(ui('words', total.toLocaleString()))}</div>
        <div class="book-desc">${textToHtml(tx(n, 'description'))}</div>
        <div class="book-actions">${btn}</div></div>
    </section>
    <h2 class="sec-h">${esc(ui('toc'))}</h2><nav class="toc">${tocHtml(n)}</nav>
  </main>`;
}

// ---------------- 阅读器 ----------------
const R = { novel: null, cid: null, page: 0, total: 1, frac: 0, stride: 0 };

async function loadChapter(n, c) {
  const key = `${n.id}/${c.id}/${c.v}`;
  if (textCache.has(key)) return textCache.get(key);
  const res = await fetch(`${chapterPath(n.id, c.id)}?v=${c.v}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(res.status);
  const t = await res.text();
  textCache.set(key, t);
  return t;
}

function readerShell(n, c) {
  return `<div class="reader">
    <header class="r-top">
      <a class="r-btn" href="#/book/${esc(n.id)}" title="${esc(ui('back'))}">‹</a>
      <div class="r-title"><b>${esc(tx(n, 'title'))}</b><span>${esc(c.part ? c.part + ' · ' : '')}${esc(c.title)}</span></div>
      <button class="r-btn" data-r="toc" title="${esc(ui('toc'))}">☰</button>
      <button class="r-btn" data-r="settings" title="${esc(ui('settings'))}">Aa</button>
    </header>
    <div class="r-view" id="r-view"><div class="r-content" id="r-content"><p class="muted">${esc(ui('loading'))}</p></div></div>
    <footer class="r-bottom">
      <button class="r-btn" data-r="prev">‹ ${esc(ui('prev'))}</button>
      <div class="r-info"><span id="r-page"></span><span id="r-book"></span></div>
      <button class="r-btn" data-r="next">${esc(ui('next'))} ›</button>
    </footer>
    <aside class="r-drawer" id="r-toc" hidden><div class="r-drawer-h">${esc(ui('toc'))}<button class="r-btn" data-r="close">✕</button></div><nav class="toc">${tocHtml(n, c.id)}</nav></aside>
    <div class="r-panel" id="r-settings" hidden>
      <div class="r-row"><span>${esc(ui('fontSize'))}</span><button class="r-btn" data-r="size-">A−</button><input type="range" id="r-size" min="14" max="32" value="${settings.size}"><button class="r-btn" data-r="size+">A+</button><b id="r-size-v">${settings.size}</b></div>
      <div class="r-row"><span>${esc(ui('lineHeight'))}</span><input type="range" id="r-line" min="1.4" max="2.6" step="0.1" value="${settings.line}"></div>
      <div class="r-row"><span>${esc(ui('theme'))}</span>${THEMES.map(t => `<button class="swatch sw-${t} ${settings.theme === t ? 'on' : ''}" data-set-theme="${t}" title="${esc(ui(t))}">${esc(ui(t))}</button>`).join('')}</div>
      <div class="r-row"><span>${esc(ui('font'))}</span><button class="r-btn ${settings.font === 'serif' ? 'on' : ''}" data-set-font="serif">${esc(ui('serif'))}</button><button class="r-btn ${settings.font === 'sans' ? 'on' : ''}" data-set-font="sans">${esc(ui('sans'))}</button></div>
    </div>
  </div>`;
}

// 用 CSS 多栏把整章排成横向的若干“页”，页数随字号自动变化
function paginate(keepFrac = true) {
  const view = $('#r-view'), content = $('#r-content');
  if (!view || !content) return;
  const w = view.clientWidth, hgt = view.clientHeight;
  const pad = Math.max(16, Math.min(48, Math.round(w * 0.06)));
  content.style.height = hgt + 'px';
  content.style.padding = `22px ${pad}px`;
  content.style.columnWidth = (w - pad * 2) + 'px';
  content.style.columnGap = (pad * 2) + 'px';
  R.stride = w;
  R.total = Math.max(1, Math.ceil((content.scrollWidth - 2) / w));
  if (keepFrac) R.page = Math.min(R.total - 1, Math.max(0, Math.floor(R.frac * R.total)));
  show();
}

function show() {
  const content = $('#r-content');
  if (!content) return;
  R.page = Math.min(Math.max(0, R.page), R.total - 1);
  content.style.transform = `translateX(${-R.page * R.stride}px)`;
  R.frac = R.total > 1 ? (R.page + 0.5) / R.total : 0;
  $('#r-page').textContent = ui('page', R.page + 1, R.total);
  $('#r-book').textContent = ui('bookProgress', bookPercent(R.novel, R.cid, R.page / Math.max(1, R.total - 1)));
  const read = new Set(getProgress(R.novel.id)?.read || []);
  if (R.page === R.total - 1) read.add(R.cid);
  saveProgress(R.novel.id, { cid: R.cid, frac: R.frac, read: [...read] });
}

function neighbor(delta) {
  const list = R.novel.chapters;
  return list[list.findIndex(c => c.id === R.cid) + delta];
}

function turn(delta) {
  const np = R.page + delta;
  if (np >= 0 && np < R.total) { R.page = np; show(); return; }
  const nc = neighbor(delta > 0 ? 1 : -1);
  if (!nc) return;
  R.startAtEnd = delta < 0;
  location.hash = `#/read/${R.novel.id}/${nc.id}`;
}

async function viewReader(nid, cid) {
  const n = findNovel(nid);
  const c = n?.chapters.find(x => x.id === cid);
  if (!n || !c || n.hidden) { viewBook(nid); return; }
  document.title = `${c.title} · ${tx(n, 'title')}`;
  const sameChapter = R.novel === n && R.cid === cid && $('#r-content');
  if (sameChapter) return;
  const pr = getProgress(n.id);
  R.novel = n; R.cid = cid;
  R.frac = R.startAtEnd ? 0.9999 : (pr?.cid === cid ? pr.frac || 0 : 0);
  R.startAtEnd = false;
  $('#app').innerHTML = readerShell(n, c);
  try {
    const text = await loadChapter(n, c);
    if (R.cid !== cid) return;
    $('#r-content').innerHTML = `<h2 class="r-ch">${esc(c.title)}</h2>${textToHtml(text)}`;
  } catch {
    $('#r-content').innerHTML = `<p class="muted">${esc(ui('loadFail'))}</p>`;
  }
  if (document.fonts?.ready) await document.fonts.ready;
  paginate(true);
}

function closePanels() {
  for (const id of ['r-toc', 'r-settings']) { const el = document.getElementById(id); if (el) el.hidden = true; }
}

// ---------------- 事件 ----------------
document.addEventListener('click', (e) => {
  const lb = e.target.closest('[data-lang]');
  if (lb) { setLang(lb.dataset.lang); R.cid = null; route(); return; }
  const th = e.target.closest('[data-set-theme]');
  if (th) { settings.theme = th.dataset.setTheme; storageSet(SETTINGS_KEY, settings); applyTheme(); document.querySelectorAll('[data-set-theme]').forEach(b => b.classList.toggle('on', b === th)); return; }
  const ft = e.target.closest('[data-set-font]');
  if (ft) { settings.font = ft.dataset.setFont; storageSet(SETTINGS_KEY, settings); applyTheme(); document.querySelectorAll('[data-set-font]').forEach(b => b.classList.toggle('on', b === ft)); paginate(); return; }
  const rb = e.target.closest('[data-r]');
  if (rb) {
    const a = rb.dataset.r;
    if (a === 'prev') turn(-1);
    else if (a === 'next') turn(1);
    else if (a === 'toc') { const t = $('#r-toc'); const was = t.hidden; closePanels(); t.hidden = !was; }
    else if (a === 'settings') { const s = $('#r-settings'); const was = s.hidden; closePanels(); s.hidden = !was; }
    else if (a === 'close') closePanels();
    else if (a === 'size-' || a === 'size+') setSize(settings.size + (a === 'size+' ? 1 : -1));
    return;
  }
  // 点击页面左右两侧翻页，中间收起面板
  const view = e.target.closest('#r-view');
  if (view) {
    if (!$('#r-toc').hidden || !$('#r-settings').hidden) { closePanels(); return; }
    const x = e.clientX / window.innerWidth;
    if (x < 0.3) turn(-1); else if (x > 0.7) turn(1);
  }
});

function setSize(v) {
  settings.size = Math.min(32, Math.max(14, v));
  storageSet(SETTINGS_KEY, settings);
  applyTheme();
  const s = $('#r-size'); if (s) s.value = settings.size;
  const sv = $('#r-size-v'); if (sv) sv.textContent = settings.size;
  paginate();
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'r-size') setSize(Number(e.target.value));
  if (e.target.id === 'r-line') { settings.line = Number(e.target.value); storageSet(SETTINGS_KEY, settings); applyTheme(); paginate(); }
});

document.addEventListener('keydown', (e) => {
  if (!$('#r-content')) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); turn(1); }
  if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); turn(-1); }
  if (e.key === 'Escape') closePanels();
});

let touchX = null;
document.addEventListener('touchstart', (e) => { if (e.target.closest('#r-view')) touchX = e.touches[0].clientX; }, { passive: true });
document.addEventListener('touchend', (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1);
});

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => paginate(), 150); });

// ---------------- 路由 ----------------
function route() {
  const seg = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  document.body.classList.toggle('reading', seg[0] === 'read');
  if (seg[0] === 'read') return viewReader(seg[1], seg[2]);
  R.cid = null;
  if (seg[0] === 'book') return viewBook(seg[1]);
  return viewLibrary();
}

window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

async function boot() {
  setLang(lang);
  applyTheme();
  try {
    const res = await fetch('data/library.json?t=' + Date.now(), { cache: 'no-store' });
    lib = normalizeLibrary(res.ok ? await res.json() : null);
  } catch { lib = normalizeLibrary(null); }
  route();
}
window.__readerBooted = true;
boot();
