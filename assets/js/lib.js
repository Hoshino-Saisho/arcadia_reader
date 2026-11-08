// 书架数据：library.json 的结构、路径、文字处理、界面文字（中英）
import { esc, storageGet, storageSet } from './util.js';

export const chapterPath = (nid, cid) => `data/novels/${nid}/${cid}.txt`;
export const coverPath = (nid) => `covers/${nid}.jpg`;

export function emptyLibrary() {
  return { version: 1, updatedAt: 0, site: { title: '书架', title_en: 'Library' }, novels: [] };
}

export function normalizeLibrary(lib) {
  lib ||= emptyLibrary();
  lib.site ||= { title: '书架', title_en: 'Library' };
  lib.novels ||= [];
  for (const n of lib.novels) {
    n.chapters ||= [];
    n.description ||= '';
    n.status ||= 'ongoing';
    for (const c of n.chapters) { c.part ||= ''; c.chars ||= 0; c.v ||= 1; }
  }
  return lib;
}

// 正文 → 段落 HTML。空行合并，“————”之类的分隔线居中显示
export function textToHtml(text) {
  const out = [];
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[—\-–=*·.。…~～#\s]{2,}$/.test(line) || /^[—–-]{2,}.*[—–-]{2,}$/.test(line)) out.push(`<p class="sep">${esc(line)}</p>`);
    else out.push(`<p>${esc(line)}</p>`);
  }
  return out.join('');
}

export function countChars(text) {
  return String(text || '').replace(/\s/g, '').length;
}

export const STATUS = {
  ongoing: ['连载中', 'Ongoing'],
  finished: ['已完结', 'Completed'],
  paused: ['暂停更新', 'On hiatus'],
};

// ---------------- 界面文字 ----------------
const STR = {
  library: ['书架', 'Library'],
  chapters: ['{0} 章', '{0} chapters'],
  words: ['{0} 字', '{0} characters'],
  start: ['开始阅读', 'Start reading'],
  continue: ['继续阅读', 'Continue'],
  toc: ['目录', 'Contents'],
  settings: ['阅读设置', 'Settings'],
  fontSize: ['字号', 'Font size'],
  lineHeight: ['行距', 'Line spacing'],
  theme: ['背景', 'Background'],
  font: ['字体', 'Font'],
  serif: ['宋体', 'Serif'],
  sans: ['黑体', 'Sans'],
  white: ['白色', 'White'],
  paper: ['纸张', 'Paper'],
  dark: ['夜间', 'Night'],
  green: ['护眼', 'Green'],
  page: ['第 {0} / {1} 页', 'Page {0} / {1}'],
  bookProgress: ['全书 {0}%', '{0}% of book'],
  prev: ['上一页', 'Previous'],
  next: ['下一页', 'Next'],
  back: ['返回', 'Back'],
  read: ['已读', 'Read'],
  reading: ['在读', 'Reading'],
  empty: ['书架上还没有小说。', 'No books yet.'],
  noChapters: ['这本书还没有章节。', 'No chapters yet.'],
  notFound: ['找不到这本书。', 'Book not found.'],
  loading: ['载入中…', 'Loading…'],
  loadFail: ['章节载入失败，请稍后再试。', 'Failed to load this chapter.'],
  endOfBook: ['已经是最后一页了', 'This is the last page'],
  lastRead: ['上次读到：{0}', 'Last read: {0}'],
  description: ['简介', 'About'],
};

const fromUrl = new URLSearchParams(location.search).get('lang');
export let lang = fromUrl === 'en' || fromUrl === 'zh' ? fromUrl
  : storageGet('arcadia-reader-lang') || ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
export function setLang(l) { lang = l; storageSet('arcadia-reader-lang', l); document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN'; }
export function ui(key, ...args) {
  const pair = STR[key]; if (!pair) return key;
  let s = pair[lang === 'en' ? 1 : 0];
  args.forEach((a, i) => { s = s.replace(`{${i}}`, a); });
  return s;
}
export const tx = (o, k) => (lang === 'en' && o?.[k + '_en']) ? o[k + '_en'] : (o?.[k] ?? '');
export const statusLabel = (s) => (STATUS[s] || STATUS.ongoing)[lang === 'en' ? 1 : 0];
