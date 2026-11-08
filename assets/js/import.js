// 导入 TXT / DOCX，并自动分章。DOCX 用浏览器自带的解压功能读取，不依赖外部库。

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// ---------- 读 zip（docx 本质上是 zip） ----------
async function unzipEntry(buf, wanted) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 docx 文件');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nlen));
    if (name === wanted) {
      const ln = dv.getUint16(local + 26, true), le = dv.getUint16(local + 28, true);
      const data = new Uint8Array(buf, local + 30 + ln + le, csize);
      if (method === 0) return dec.decode(data);
      if (method !== 8) throw new Error('不支持的压缩方式');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).text();
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

// 返回段落数组：[{text, style}]，style 是小写的样式名（title / subtitle / heading 1 …）
export async function parseDocx(buf) {
  const docXml = await unzipEntry(buf, 'word/document.xml');
  if (!docXml) throw new Error('docx 里找不到正文');
  const stylesXml = await unzipEntry(buf, 'word/styles.xml');
  const styleName = {};
  const parser = new DOMParser();
  if (stylesXml) {
    const sd = parser.parseFromString(stylesXml, 'application/xml');
    for (const s of sd.getElementsByTagNameNS(W, 'style')) {
      const id = s.getAttributeNS(W, 'styleId') || s.getAttribute('w:styleId');
      const nm = s.getElementsByTagNameNS(W, 'name')[0];
      if (id) styleName[id] = (nm?.getAttributeNS(W, 'val') || nm?.getAttribute('w:val') || id).toLowerCase();
    }
  }
  const doc = parser.parseFromString(docXml, 'application/xml');
  const out = [];
  for (const p of doc.getElementsByTagNameNS(W, 'p')) {
    const ps = p.getElementsByTagNameNS(W, 'pStyle')[0];
    const sid = ps ? (ps.getAttributeNS(W, 'val') || ps.getAttribute('w:val')) : '';
    let text = '';
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.namespaceURI === W && c.localName === 't') text += c.textContent;
        else if (c.namespaceURI === W && c.localName === 'tab') text += '\t';
        else if (c.namespaceURI === W && (c.localName === 'br' || c.localName === 'cr')) text += '\n';
        else if (c.nodeType === 1 && c.localName !== 'pPr') walk(c);
      }
    };
    walk(p);
    out.push({ text, style: (styleName[sid] || sid || '').toLowerCase() });
  }
  return out;
}

export function parseTxt(text) {
  return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map(t => ({ text: t, style: '' }));
}

// ---------- 自动分章 ----------
const NUM = '[一二三四五六七八九十百千零〇两\\d]+';
const PART_RE = new RegExp(`^(第${NUM}[篇部卷集]|(part|book|volume)\\s+[\\w\\d]+)`, 'i');
const CHAP_RE = new RegExp(`^(第${NUM}[章回节话]|序章|序言|楔子|前言|引子|尾声|后记|终章|番外|chapter\\s+[\\w\\d]+|prologue|epilogue)`, 'i');

function kind(p) {
  const t = p.text.trim();
  if (!t || t.length > 40) return '';
  if (p.style === 'title' || p.style === 'heading 1' || PART_RE.test(t)) return 'part';
  if (p.style === 'subtitle' || p.style === 'heading 2' || CHAP_RE.test(t)) return 'chapter';
  return '';
}

// 返回 [{title, part, text}]
export function splitChapters(paras) {
  const chapters = [];
  let part = '';
  let cur = null;
  const flush = () => {
    if (cur && (cur.lines.some(l => l.trim()) || cur.explicit)) {
      chapters.push({ title: cur.title, part: cur.part, text: cur.lines.join('\n').replace(/^\n+|\n+$/g, '') });
    }
    cur = null;
  };
  for (const p of paras) {
    for (const line of p.text.split('\n')) {
      const k = kind({ text: line, style: p.style });
      const t = line.trim();
      if (k === 'part') { flush(); part = t; continue; }
      if (k === 'chapter') { flush(); cur = { title: t, part, lines: [], explicit: true }; continue; }
      if (!cur) {
        if (!t) continue;
        cur = { title: part || '正文', part, lines: [] };
      }
      cur.lines.push(line.replace(/\s+$/, ''));
    }
  }
  flush();
  return chapters;
}

export async function readFileAsChapters(file) {
  const name = file.name.toLowerCase();
  let paras;
  if (name.endsWith('.docx')) paras = await parseDocx(await file.arrayBuffer());
  else if (name.endsWith('.txt') || name.endsWith('.md')) paras = parseTxt(await file.text());
  else throw new Error('只支持 .txt 或 .docx 文件（.doc 请先在 Word 里另存为 .docx）');
  return splitChapters(paras);
}
