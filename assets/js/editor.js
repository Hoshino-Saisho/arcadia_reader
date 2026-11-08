// 编辑器：管理书架、小说信息、封面、章节，一键发布到 GitHub
import { $, $$, esc, uid, move, toast } from './util.js';
import { getConfig, setConfig, logout, isConfigured, guessRepo, verify, readText, commitFiles } from './gh.js';
import { normalizeLibrary, emptyLibrary, chapterPath, coverPath, countChars, STATUS } from './lib.js';
import { readFileAsChapters } from './import.js';

const S = {
  lib: null,              // 正在编辑的书架
  base: 0,                // 载入时网站上书架的 updatedAt
  remote: new Set(),      // 网站上已经存在的文件路径
  changes: new Map(),     // 待发布的文件：path → {text} | {base64} | {remove:true}
  texts: new Map(),       // 已载入的章节正文缓存
  coverPreview: {},       // 还没发布的封面预览（dataURL）
  dirty: false,
  busy: false,
};
const app = () => $('#app');

// ---------------- 草稿（存在浏览器的 IndexedDB 里，关掉网页也不会丢） ----------------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('arcadia-reader-editor', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const req = fn(db.transaction('kv', mode).objectStore('kv'));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
const idbGet = (k) => idbDo('readonly', s => s.get(k)).catch(() => null);
const idbSet = (k, v) => idbDo('readwrite', s => s.put(v, k)).catch(() => null);
const idbDel = (k) => idbDo('readwrite', s => s.delete(k)).catch(() => null);
const repoKey = () => { const c = getConfig(); return `${c.owner}/${c.repo}@${c.branch}`; };

let draftTimer;
function touch() {
  S.dirty = true;
  updatePending();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => idbSet('draft', {
    repo: repoKey(), savedAt: Date.now(), base: S.base, lib: S.lib, changes: [...S.changes], coverPreview: S.coverPreview,
  }), 400);
}

function updatePending() {
  const el = $('#ed-pending');
  if (el) el.textContent = S.dirty ? `● 有未发布的修改（${S.changes.size} 个文件 + 书架信息）` : '✓ 已与网站同步';
  el?.classList.toggle('warn', S.dirty);
  const pb = $('#ed-publish'); if (pb) pb.disabled = !S.dirty || S.busy;
  const db = $('#ed-discard'); if (db) db.disabled = !S.dirty || S.busy;
}

window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------------- 文件变更 ----------------
function putFile(path, change) { S.changes.set(path, change); }
function removeFile(path) {
  if (S.remote.has(path)) S.changes.set(path, { remove: true });
  else S.changes.delete(path);
  S.texts.delete(path);
}
function remoteFilesOf(lib) {
  const set = new Set();
  for (const n of lib.novels) {
    if (n.cover) set.add(coverPath(n.id));
    for (const c of n.chapters) set.add(chapterPath(n.id, c.id));
  }
  return set;
}
function newId(prefix, taken) {
  let id;
  do { id = uid(prefix); } while (taken.some(x => x.id === id));
  return id;
}

async function getText(n, c) {
  const path = chapterPath(n.id, c.id);
  const ch = S.changes.get(path);
  if (ch && 'text' in ch) return ch.text;
  if (S.texts.has(path)) return S.texts.get(path);
  if (!S.remote.has(path)) return '';
  const t = (await readText(path)) ?? '';
  S.texts.set(path, t);
  return t;
}

// ---------------- 登录 ----------------
function renderLogin(err = '') {
  const c = getConfig();
  const g = guessRepo();
  app().innerHTML = `<main class="ed-login">
    <h1>小说编辑器</h1>
    <p class="muted">只有拥有 GitHub 写入令牌的人能进入。令牌只保存在这台电脑的浏览器里。</p>
    ${err ? `<p class="ed-err">${esc(err)}</p>` : ''}
    <label>GitHub 用户名<input id="lg-owner" value="${esc(c.owner || g.owner)}" autocomplete="username"></label>
    <label>仓库名<input id="lg-repo" value="${esc(c.repo || g.repo)}"></label>
    <label>分支<input id="lg-branch" value="${esc(c.branch || 'main')}"></label>
    <label>令牌（Fine-grained token）<input id="lg-token" type="password" value="${esc(c.token)}" autocomplete="current-password" placeholder="github_pat_…"></label>
    <button class="btn primary" id="lg-go">登录</button>
    <details><summary>怎么获取令牌？</summary>
      <ol><li>GitHub 右上角头像 → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token。</li>
      <li>Repository access 选 <b>Only select repositories</b>，只勾这个小说仓库。</li>
      <li>Permissions → Repository permissions → <b>Contents</b> 选 <b>Read and write</b>。</li>
      <li>生成后复制（以 github_pat_ 开头），粘贴到上面。</li></ol>
    </details>
  </main>`;
  $('#lg-go').onclick = async () => {
    const cfg = { owner: $('#lg-owner').value.trim(), repo: $('#lg-repo').value.trim(), branch: $('#lg-branch').value.trim() || 'main', token: $('#lg-token').value.trim() };
    if (!cfg.owner || !cfg.repo || !cfg.token) return renderLogin('请把用户名、仓库名和令牌都填上。');
    $('#lg-go').disabled = true; $('#lg-go').textContent = '验证中…';
    try { await verify(cfg); setConfig(cfg); await start(); }
    catch (e) { renderLogin('登录失败：' + e.message); }
  };
}

// ---------------- 载入 ----------------
async function loadLibrary() {
  const txt = await readText('data/library.json');
  let remoteLib;
  try { remoteLib = normalizeLibrary(txt ? JSON.parse(txt) : emptyLibrary()); }
  catch { throw new Error('data/library.json 格式坏了，无法解析'); }
  S.base = remoteLib.updatedAt || 0;
  S.remote = remoteFilesOf(remoteLib);
  S.lib = remoteLib;
  S.changes = new Map(); S.texts = new Map(); S.coverPreview = {}; S.dirty = false;
  const d = await idbGet('draft');
  if (d && d.repo === repoKey()) {
    const when = new Date(d.savedAt).toLocaleString();
    if (confirm(`发现一份没有发布的草稿（${when}）。\n要恢复吗？选“取消”会丢弃这份草稿。`)) {
      S.lib = normalizeLibrary(d.lib);
      S.changes = new Map(d.changes || []);
      S.coverPreview = d.coverPreview || {};
      S.dirty = true;
      if ((d.base || 0) !== S.base) toast('注意：保存草稿之后网站又被更新过。发布时会以这份草稿为准。', 7000);
    } else await idbDel('draft');
  }
}

async function start() {
  app().innerHTML = '<p class="ed-loading">载入中…</p>';
  try { await loadLibrary(); }
  catch (e) { app().innerHTML = `<main class="ed-login"><p class="ed-err">载入失败：${esc(e.message)}</p><button class="btn" data-act="logout">重新登录</button></main>`; return; }
  route();
}

// ---------------- 页面 ----------------
function toolbar() {
  const c = getConfig();
  return `<header class="ed-bar">
    <b class="ed-brand">编辑器</b><span class="muted ed-repo">${esc(c.owner)}/${esc(c.repo)}</span>
    <span id="ed-pending" class="ed-pending"></span>
    <span class="ed-bar-tools">
      <a class="btn" href="index.html" target="_blank" rel="noopener">查看网站 ↗</a>
      <button class="btn" id="ed-discard" data-act="discard">放弃修改</button>
      <button class="btn primary" id="ed-publish" data-act="publish">发布</button>
      <button class="btn" data-act="logout">退出</button>
    </span>
  </header>`;
}

function coverSrc(n) { return S.coverPreview[n.id] || n.cover || ''; }
function thumb(n, cls = '') {
  const src = coverSrc(n);
  return src ? `<img class="ed-thumb ${cls}" src="${esc(src)}" alt="">` : `<div class="ed-thumb ed-thumb-blank ${cls}">${esc((n.title || '?').slice(0, 4))}</div>`;
}
const statusOpts = (cur) => Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v[0]}</option>`).join('');
const totalChars = (n) => n.chapters.reduce((s, c) => s + (c.chars || 0), 0);

function viewList() {
  const L = S.lib;
  const rows = L.novels.map((n, i) => `<div class="ed-row">
      ${thumb(n)}
      <div class="ed-grow"><b>${esc(n.title || '（未命名）')}</b>${n.hidden ? ' <span class="ed-tag">隐藏中</span>' : ''}
        <div class="muted">${esc(n.author || '')} · ${STATUS[n.status]?.[0] || ''} · ${n.chapters.length} 章 · ${totalChars(n).toLocaleString()} 字</div></div>
      <button class="r-btn" data-act="novel-up" data-i="${i}" title="上移">↑</button>
      <button class="r-btn" data-act="novel-down" data-i="${i}" title="下移">↓</button>
      <a class="btn" href="#/novel/${esc(n.id)}">编辑</a>
    </div>`).join('');
  app().innerHTML = `${toolbar()}<main class="ed-main">
    <section class="ed-card"><h2>书架设置</h2>
      <div class="ed-grid2">
        <label>书架名称（中文）<input data-scope="site" data-key="title" value="${esc(L.site.title)}"></label>
        <label>书架名称（English）<input data-scope="site" data-key="title_en" value="${esc(L.site.title_en || '')}"></label>
      </div></section>
    <section class="ed-card">
      <div class="ed-head"><h2>小说（${L.novels.length}）</h2>
        <div class="ed-actions"><button class="btn primary" data-act="new-novel">＋ 新建小说</button>
        <label class="btn">从 TXT / DOCX 新建…<input type="file" accept=".txt,.md,.docx" data-file="import-new" hidden></label></div></div>
      <label class="dropzone small" data-drop="import-new">也可以把 TXT / DOCX 文件拖到这里，直接新建一本小说
        <input type="file" accept=".txt,.md,.docx" data-file="import-new" hidden></label>
      ${rows || '<p class="muted">还没有小说，点上面的按钮新建一本。</p>'}
    </section></main>`;
  updatePending();
}

function viewNovel(id) {
  const n = S.lib.novels.find(x => x.id === id);
  if (!n) { location.hash = '#/'; return; }
  const src = coverSrc(n);
  let part = null;
  const rows = n.chapters.map((c, i) => {
    const head = c.part && c.part !== part ? `<div class="ed-part">${esc(c.part)}</div>` : '';
    part = c.part || part;
    return `${head}<div class="ed-row ed-ch">
      <span class="ed-idx">${i + 1}</span>
      <a class="ed-grow" href="#/chapter/${esc(n.id)}/${esc(c.id)}">${esc(c.title || '（无标题）')}</a>
      <span class="muted">${(c.chars || 0).toLocaleString()} 字</span>
      <button class="r-btn" data-act="ch-up" data-i="${i}" title="上移">↑</button>
      <button class="r-btn" data-act="ch-down" data-i="${i}" title="下移">↓</button>
      <button class="r-btn" data-act="ch-del" data-i="${i}" title="删除">✕</button>
    </div>`;
  }).join('');
  app().innerHTML = `${toolbar()}<main class="ed-main">
    <a class="ed-back" href="#/">‹ 返回书架</a>
    <section class="ed-card ed-novel">
      <div class="ed-cover-col">
        <label class="dropzone cover-drop" data-drop="cover">
          ${src ? `<img src="${esc(src)}" alt="">` : '<span>把封面图片拖到这里<br>或点击选择文件</span>'}
          <input type="file" accept="image/*" data-file="cover" hidden>
        </label>
        <small class="muted">竖版 2:3 最好看。会自动压缩成 JPG。</small>
        ${n.cover ? '<button class="btn" data-act="remove-cover">移除封面</button>' : ''}
      </div>
      <div class="ed-fields">
        <div class="ed-grid2">
          <label>书名<input data-scope="novel" data-key="title" value="${esc(n.title)}"></label>
          <label>英文书名（可空）<input data-scope="novel" data-key="title_en" value="${esc(n.title_en || '')}"></label>
          <label>作者<input data-scope="novel" data-key="author" value="${esc(n.author || '')}"></label>
          <label>状态<select data-scope="novel" data-key="status">${statusOpts(n.status)}</select></label>
        </div>
        <label>简介<textarea rows="6" data-scope="novel" data-key="description">${esc(n.description)}</textarea></label>
        <label>英文简介（可空）<textarea rows="3" data-scope="novel" data-key="description_en">${esc(n.description_en || '')}</textarea></label>
        <label class="ed-check"><input type="checkbox" data-scope="novel" data-key="hidden" ${n.hidden ? 'checked' : ''}> 暂时隐藏（读者在书架上看不到这本）</label>
        <a class="muted" href="index.html#/book/${esc(n.id)}" target="_blank" rel="noopener">在网站上查看 ↗（发布后）</a>
      </div>
    </section>
    <section class="ed-card">
      <div class="ed-head"><h2>章节（${n.chapters.length} 章 · ${totalChars(n).toLocaleString()} 字）</h2>
        <div class="ed-actions"><button class="btn primary" data-act="ch-add">＋ 新章节</button>
        <label class="btn">导入 TXT / DOCX…<input type="file" accept=".txt,.md,.docx" data-file="import" hidden></label></div></div>
      <label class="dropzone small" data-drop="import">把 TXT / DOCX 拖到这里导入章节（会自动按“第X章”或 Word 标题分章）
        <input type="file" accept=".txt,.md,.docx" data-file="import" hidden></label>
      ${rows || '<p class="muted">还没有章节。</p>'}
    </section>
    <section class="ed-card ed-danger"><button class="btn danger" data-act="novel-del">删除这本小说</button>
      <span class="muted">会同时删除它的所有章节和封面（发布后生效）。</span></section>
  </main>`;
  S.cur = { n };
  updatePending();
}

async function viewChapter(nid, cid) {
  const n = S.lib.novels.find(x => x.id === nid);
  const c = n?.chapters.find(x => x.id === cid);
  if (!c) { location.hash = n ? `#/novel/${nid}` : '#/'; return; }
  const i = n.chapters.indexOf(c);
  const prev = n.chapters[i - 1], next = n.chapters[i + 1];
  app().innerHTML = `${toolbar()}<main class="ed-main">
    <a class="ed-back" href="#/novel/${esc(n.id)}">‹ 返回《${esc(n.title || '未命名')}》</a>
    <section class="ed-card">
      <div class="ed-grid2">
        <label>章节标题<input data-scope="chapter" data-key="title" value="${esc(c.title)}"></label>
        <label>所属篇 / 卷（可空，同名的会归在一起）<input data-scope="chapter" data-key="part" value="${esc(c.part || '')}" list="ed-parts"></label>
      </div>
      <datalist id="ed-parts">${[...new Set(n.chapters.map(x => x.part).filter(Boolean))].map(p => `<option value="${esc(p)}">`).join('')}</datalist>
      <textarea id="ch-text" class="ed-text" placeholder="正文。每一行是一个段落；单独一行的“——”或“***”会显示成分隔线。" disabled>载入中…</textarea>
      <div class="ed-foot">
        <span id="ch-count" class="muted"></span>
        <span class="ed-actions">
          ${prev ? `<a class="btn" href="#/chapter/${esc(n.id)}/${esc(prev.id)}">‹ 上一章</a>` : ''}
          ${next ? `<a class="btn" href="#/chapter/${esc(n.id)}/${esc(next.id)}">下一章 ›</a>` : ''}
        </span>
      </div>
    </section></main>`;
  S.cur = { n, c };
  updatePending();
  const ta = $('#ch-text');
  try {
    const t = await getText(n, c);
    if (S.cur?.c !== c) return;
    ta.value = t; ta.disabled = false;
    $('#ch-count').textContent = `${countChars(t).toLocaleString()} 字`;
  } catch (e) { ta.value = '正文载入失败：' + e.message; }
}

function route() {
  const seg = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  S.cur = null;
  if (seg[0] === 'novel') viewNovel(seg[1]);
  else if (seg[0] === 'chapter') viewChapter(seg[1], seg[2]);
  else viewList();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { if (isConfigured() && S.lib) route(); });

// ---------------- 弹窗 ----------------
function modal(html) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'ed-modal-bg';
    bg.innerHTML = `<div class="ed-modal">${html}<div class="ed-modal-foot"><button class="btn" data-m="cancel">取消</button><button class="btn primary" data-m="ok">确定</button></div></div>`;
    document.body.appendChild(bg);
    bg.addEventListener('click', (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m && e.target !== bg) return;
      const box = bg.querySelector('.ed-modal');
      resolve(m === 'ok' ? box : null);
      if (m === 'ok') setTimeout(() => bg.remove(), 0); else bg.remove();
    });
  });
}

// ---------------- 封面 ----------------
async function setCover(n, file) {
  if (!file || !file.type.startsWith('image/')) { toast('请选择图片文件（JPG / PNG / WEBP）'); return; }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('图片读取失败')); im.src = url; });
    const k = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), hgt = Math.round(img.naturalHeight * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = hgt;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt); ctx.drawImage(img, 0, 0, w, hgt);
    const dataUrl = cv.toDataURL('image/jpeg', 0.88);
    putFile(coverPath(n.id), { base64: dataUrl.split(',')[1] });
    S.coverPreview[n.id] = dataUrl;
    n.cover = `${coverPath(n.id)}?v=${Date.now()}`;
    n.updatedAt = Date.now();
    touch();
    viewNovel(n.id);
    toast(`封面已更新（${w}×${hgt}，${Math.round(dataUrl.length * 0.75 / 1024)} KB），记得发布`);
  } catch (e) { toast(e.message); }
  finally { URL.revokeObjectURL(url); }
}

// ---------------- 导入 ----------------
async function importFile(n, file) {
  let chapters;
  try { chapters = await readFileAsChapters(file); }
  catch (e) { toast('导入失败：' + e.message, 5000); return false; }
  if (!chapters.length) { toast('文件里没有读到文字'); return false; }
  const total = chapters.reduce((s, c) => s + countChars(c.text), 0);
  const rows = chapters.map((c, i) => `<tr><td><input type="checkbox" data-imp-on="${i}" checked></td>
    <td><input data-imp-part="${i}" value="${esc(c.part)}" placeholder="（无）"></td>
    <td><input data-imp-title="${i}" value="${esc(c.title)}"></td>
    <td class="muted">${countChars(c.text).toLocaleString()}</td></tr>`).join('');
  const box = await modal(`<h3>导入预览：${esc(file.name)}</h3>
    <p>识别到 <b>${chapters.length}</b> 章，共 ${total.toLocaleString()} 字。标题和篇名可以在这里直接改。</p>
    ${n.chapters.length ? `<div class="ed-radio"><label><input type="radio" name="imp-mode" value="append" checked> 接在现有 ${n.chapters.length} 章后面</label>
      <label><input type="radio" name="imp-mode" value="replace"> 替换掉现有的全部章节</label></div>` : ''}
    <div class="ed-imp"><table><thead><tr><th></th><th>篇 / 卷</th><th>章节标题</th><th>字数</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted">没分对？章节标题要单独占一行，比如“第一章 …”“序章”“尾声”，或在 Word 里用“标题 / 副标题”样式。</p>`);
  if (!box) return false;
  if (box.querySelector('[name=imp-mode]:checked')?.value === 'replace') {
    for (const c of n.chapters) removeFile(chapterPath(n.id, c.id));
    n.chapters = [];
  }
  let added = 0;
  chapters.forEach((ch, i) => {
    if (!box.querySelector(`[data-imp-on="${i}"]`).checked) return;
    const c = {
      id: newId('c', n.chapters),
      title: box.querySelector(`[data-imp-title="${i}"]`).value.trim() || ch.title,
      part: box.querySelector(`[data-imp-part="${i}"]`).value.trim(),
      chars: countChars(ch.text), v: Date.now(),
    };
    n.chapters.push(c);
    putFile(chapterPath(n.id, c.id), { text: ch.text });
    S.texts.set(chapterPath(n.id, c.id), ch.text);
    added++;
  });
  n.updatedAt = Date.now();
  touch();
  toast(`已导入 ${added} 章，记得发布`);
  return true;
}

function newNovel(title = '') {
  const n = { id: newId('b', S.lib.novels), title, title_en: '', author: '', description: '', status: 'ongoing', hidden: false, cover: '', updatedAt: Date.now(), chapters: [] };
  S.lib.novels.push(n);
  touch();
  return n;
}

async function handleFile(kind, file) {
  if (!file) return;
  if (kind === 'cover' && S.cur?.n) return setCover(S.cur.n, file);
  if (kind === 'import' && S.cur?.n) { if (await importFile(S.cur.n, file)) viewNovel(S.cur.n.id); return; }
  if (kind === 'import-new') {
    const n = newNovel(file.name.replace(/\.[^.]+$/, ''));
    if (await importFile(n, file)) { location.hash = `#/novel/${n.id}`; return; }
    S.lib.novels.splice(S.lib.novels.indexOf(n), 1);
    viewList();
  }
}

// ---------------- 发布 ----------------
async function publish() {
  if (!S.dirty || S.busy) return;
  const box = await modal(`<h3>发布到网站</h3>
    <p>将提交 ${S.changes.size} 个文件和书架信息，GitHub Pages 通常 1 分钟左右更新。</p>
    <label>这次更新的说明（可空）<input id="pub-msg" placeholder="例如：更新第 12 章"></label>`);
  if (!box) return;
  const msg = box.querySelector('#pub-msg').value.trim() || '更新书架';
  S.busy = true; updatePending();
  const pb = $('#ed-publish'); if (pb) pb.textContent = '发布中…';
  try {
    S.lib.updatedAt = Date.now();
    const files = [...S.changes].map(([path, c]) => ({ path, ...c }));
    files.push({ path: 'data/library.json', text: JSON.stringify(S.lib, null, 2) + '\n' });
    await commitFiles(files, msg);
    for (const [path, c] of S.changes) { if (c.remove) S.remote.delete(path); else S.remote.add(path); }
    S.changes.clear(); S.dirty = false; S.base = S.lib.updatedAt;
    await idbDel('draft');
    toast('发布成功！网站大约 1 分钟后更新。', 5000);
  } catch (e) {
    toast('发布失败：' + e.message, 8000);
  } finally {
    S.busy = false;
    if (pb) pb.textContent = '发布';
    updatePending();
  }
}

// ---------------- 事件 ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || S.busy) return;
  const a = el.dataset.act, i = Number(el.dataset.i);
  const n = S.cur?.n;
  if (a === 'logout') {
    if (S.dirty && !confirm('还有没发布的修改（草稿会保留在这台电脑上）。确定退出吗？')) return;
    S.dirty = false; logout(); renderLogin();
  } else if (a === 'publish') publish();
  else if (a === 'discard') {
    if (!confirm('放弃所有没发布的修改，恢复成网站上的版本？')) return;
    await idbDel('draft'); S.dirty = false; await start();
  } else if (a === 'new-novel') { const nn = newNovel('新小说'); location.hash = `#/novel/${nn.id}`; }
  else if (a === 'novel-up' || a === 'novel-down') { move(S.lib.novels, i, a === 'novel-up' ? -1 : 1); touch(); viewList(); }
  else if (!n) return;
  else if (a === 'remove-cover') {
    removeFile(coverPath(n.id)); delete S.coverPreview[n.id]; n.cover = ''; touch(); viewNovel(n.id);
  } else if (a === 'ch-add') {
    const last = n.chapters[n.chapters.length - 1];
    const c = { id: newId('c', n.chapters), title: `第${n.chapters.length + 1}章`, part: last?.part || '', chars: 0, v: Date.now() };
    n.chapters.push(c); putFile(chapterPath(n.id, c.id), { text: '' }); n.updatedAt = Date.now(); touch();
    location.hash = `#/chapter/${n.id}/${c.id}`;
  } else if (a === 'ch-up' || a === 'ch-down') { move(n.chapters, i, a === 'ch-up' ? -1 : 1); touch(); viewNovel(n.id); }
  else if (a === 'ch-del') {
    const c = n.chapters[i];
    if (!confirm(`删除章节「${c.title}」？`)) return;
    removeFile(chapterPath(n.id, c.id)); n.chapters.splice(i, 1); touch(); viewNovel(n.id);
  } else if (a === 'novel-del') {
    if (prompt(`确定要删除《${n.title}》吗？请输入书名确认：`) !== n.title) { toast('书名不一致，已取消'); return; }
    for (const c of n.chapters) removeFile(chapterPath(n.id, c.id));
    removeFile(coverPath(n.id)); delete S.coverPreview[n.id];
    S.lib.novels.splice(S.lib.novels.indexOf(n), 1); touch();
    location.hash = '#/';
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'ch-text' && S.cur?.c) {
    const { n, c } = S.cur;
    const path = chapterPath(n.id, c.id);
    putFile(path, { text: t.value }); S.texts.set(path, t.value);
    c.chars = countChars(t.value); c.v = Date.now(); n.updatedAt = Date.now();
    $('#ch-count').textContent = `${c.chars.toLocaleString()} 字`;
    touch(); return;
  }
  const scope = t.dataset.scope;
  if (!scope) return;
  const obj = scope === 'site' ? S.lib.site : scope === 'novel' ? S.cur?.n : S.cur?.c;
  if (!obj) return;
  obj[t.dataset.key] = t.type === 'checkbox' ? t.checked : t.value;
  if (scope !== 'site' && S.cur?.n) S.cur.n.updatedAt = Date.now();
  touch();
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.file) { handleFile(t.dataset.file, t.files[0]); t.value = ''; }
  else if (t.dataset.scope && t.tagName === 'SELECT') t.dispatchEvent(new Event('input', { bubbles: true }));
});

// 拖放文件
document.addEventListener('dragover', (e) => {
  const z = e.target.closest('[data-drop]');
  e.preventDefault();
  $$('.dropzone.over').forEach(x => x !== z && x.classList.remove('over'));
  if (z) z.classList.add('over');
});
document.addEventListener('dragleave', (e) => { const z = e.target.closest('[data-drop]'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('over'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const z = e.target.closest('[data-drop]');
  $$('.dropzone.over').forEach(x => x.classList.remove('over'));
  if (z && e.dataTransfer.files[0]) handleFile(z.dataset.drop, e.dataTransfer.files[0]);
});

// ---------------- 启动 ----------------
window.__readerBooted = true;
(async () => {
  document.documentElement.dataset.theme = 'paper';
  if (!isConfigured()) return renderLogin();
  try { await verify(getConfig()); }
  catch (e) { return renderLogin('登录信息失效：' + e.message); }
  await start();
})();
