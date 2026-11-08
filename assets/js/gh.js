// GitHub API：登录验证、读取文件、把多个文件合成一次提交发布
import { storageGet, storageSet, storageDel, utf8ToBase64 } from './util.js';

const KEY = 'arcadia-reader-github';

export function getConfig() {
  return { owner: '', repo: '', branch: 'main', token: '', ...storageGet(KEY, {}) };
}
export function setConfig(c) { storageSet(KEY, c); }
export function logout() { storageDel(KEY); }
export function isConfigured() { const c = getConfig(); return !!(c.owner && c.repo && c.token); }

// 从网址猜用户名和仓库名：xxx.github.io/仓库名/editor.html
export function guessRepo() {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/i);
  if (!m) return { owner: '', repo: '' };
  const segs = location.pathname.split('/').filter(Boolean);
  if (segs.length && segs[segs.length - 1].includes('.')) segs.pop();
  return { owner: m[1], repo: segs[0] || `${m[1]}.github.io` };
}

async function api(cfg, path, opts = {}, accept = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${path}`, {
    ...opts, cache: 'no-store',
    headers: { Accept: accept, Authorization: `Bearer ${cfg.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += ' ' + (await res.json()).message; } catch { /* ignore */ }
    if (res.status === 401) msg += '（令牌无效或已过期）';
    if (res.status === 403) msg += '（令牌没有写入权限）';
    if (res.status === 404) msg += '（找不到仓库或文件：检查用户名、仓库名，或者令牌没有授权这个仓库）';
    if (res.status === 409) msg += '（仓库是空的：请先在 GitHub 上给仓库添加一个 README 文件）';
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return accept.includes('raw') ? res.text() : res.json();
}

export async function verify(cfg) {
  const r = await api(cfg, '');
  if (r.permissions && !r.permissions.push) throw new Error('这个令牌只能读、不能写。请给令牌加上 Contents: Read and write 权限。');
  return r.full_name;
}

// 读取仓库里的文本文件（不存在时返回 null）
export async function readText(path, cfg = getConfig()) {
  try {
    return await api(cfg, `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(cfg.branch)}`, {}, 'application/vnd.github.raw+json');
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// 一次提交多个文件。changes: [{path, text} | {path, base64} | {path, remove: true}]
export async function commitFiles(changes, message, cfg = getConfig()) {
  const ref = await api(cfg, `/git/ref/heads/${encodeURIComponent(cfg.branch)}`);
  const parent = ref.object.sha;
  const base = await api(cfg, `/git/commits/${parent}`);
  const tree = [];
  for (const c of changes) {
    if (c.remove) { tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null }); continue; }
    const content = c.base64 ?? utf8ToBase64(c.text ?? '');
    const blob = await api(cfg, '/git/blobs', { method: 'POST', body: JSON.stringify({ content, encoding: 'base64' }) });
    tree.push({ path: c.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await api(cfg, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
  const commit = await api(cfg, '/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [parent] }) });
  await api(cfg, `/git/refs/heads/${encodeURIComponent(cfg.branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  return commit.sha;
}
