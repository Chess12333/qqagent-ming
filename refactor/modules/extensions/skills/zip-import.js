// Install a 0.4 extension ZIP without running its installer scripts.
// A package may wrap the extension in one or more directories (including plugins/<id>/).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yauzl from 'yauzl';
import { normalizeManifest, isManifestUsable } from './manifest.js';

const MAX_ARCHIVE = 20 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;

function cleanPath(name) {
  const raw = String(name || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!raw || raw.startsWith('/') || raw.includes('\u0000') || /^[A-Za-z]:/.test(raw)) throw new Error('ZIP 包含不安全的文件路径');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes(':'))) throw new Error('ZIP 包含不安全的文件路径');
  return parts.join('/');
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function scanEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const seen = new Set();
    let total = 0;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    zip.on('error', fail);
    zip.on('entry', (entry) => {
      if (settled) return;
      try {
        if (entries.length >= 2000) throw new Error('ZIP 文件数超过 2000');
        const isDirectory = /[/\\]$/.test(entry.fileName);
        if (isDirectory && /^(?:\.\/)*$/.test(entry.fileName)) { zip.readEntry(); return; }
        const name = cleanPath(entry.fileName);
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (unixType === 0o120000) throw new Error(`ZIP 包含符号链接：${name}`);
        if (!isDirectory) {
          if (seen.has(name)) throw new Error(`ZIP 文件路径重复：${name}`);
          seen.add(name);
          if (entry.uncompressedSize > MAX_FILE) throw new Error(`ZIP 内文件过大：${name}`);
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL) throw new Error('ZIP 解压后体积超过 100MB');
          entries.push({ name, entry });
        }
        zip.readEntry();
      } catch (error) { fail(error); }
    });
    zip.on('end', () => { if (!settled) { settled = true; resolve(entries); } });
    zip.readEntry();
  });
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_FILE) stream.destroy(new Error('ZIP 内文件超过 20MB'));
        else chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

export async function importExtensionZip(buffer, { root, plugins, skills } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_ARCHIVE) {
    throw new Error('只支持不超过 20MB 的插件 ZIP');
  }
  const zip = await openZip(buffer);
  let tempRoot = '';
  try {
    const entries = await scanEntries(zip);
    const manifests = entries.filter(({ name }) => /(?:^|\/)(?:plugin|skill)\.json$/i.test(name));
    if (!manifests.length) throw new Error('ZIP 中没有 plugin.json 或 skill.json');
    const candidates = [];
    const usedIds = new Set();
    for (const item of manifests) {
      let raw;
      try { raw = JSON.parse((await readEntry(zip, item.entry)).toString('utf8').replace(/^\uFEFF/, '')); }
      catch (error) { throw new Error(`${item.name} 解析失败：${error?.message || error}`); }
      const prefix = item.name.slice(0, item.name.lastIndexOf('/') + 1);
      const fallbackId = prefix ? prefix.split('/').filter(Boolean).at(-1) : '';
      const { manifest, problems } = normalizeManifest(raw, { fallbackId });
      if (!isManifestUsable(manifest, problems)) throw new Error(`${item.name} 清单不可用：${problems.join('；')}`);
      const source = path.posix.basename(item.name).toLowerCase() === 'plugin.json' ? 'plugins' : 'skills';
      const kind = prefix.split('/').find((part) => part === 'plugins' || part === 'skills') || source;
      const targetRoot = kind === 'plugins' ? plugins : skills;
      const target = path.join(targetRoot, manifest.id);
      const entryFile = String(raw.entry || raw.main || 'index.js').replace(/\\/g, '/');
      if (!entryFile || entryFile.startsWith('/') || entryFile.split('/').some((p) => !p || p === '..')) {
        throw new Error(`${manifest.id} 入口文件路径不合法`);
      }
      if (!entries.some((e) => e.name === prefix + entryFile)) throw new Error(`${manifest.id} 缺少入口文件 ${entryFile}`);
      if (usedIds.has(manifest.id)) throw new Error(`ZIP 中重复的扩展 ID：${manifest.id}`);
      usedIds.add(manifest.id);
      candidates.push({ id: manifest.id, name: manifest.name, kind, prefix, target, files: entries.filter((e) => e.name.startsWith(prefix)) });
    }
    const skipped = candidates.filter((c) => fs.existsSync(c.target)).map((c) => ({ id: c.id, reason: '已有同名扩展，未覆盖' }));
    const pending = candidates.filter((c) => !fs.existsSync(c.target));
    if (!pending.length) return { installed: [], skipped };

    const resolvedRoot = path.resolve(root);
    tempRoot = path.resolve(resolvedRoot, '.tmp', `plugin-import-${randomUUID()}`);
    if (!tempRoot.startsWith(resolvedRoot + path.sep)) throw new Error('临时目录越界');
    fs.mkdirSync(tempRoot, { recursive: true });
    for (const item of pending) {
      const staging = path.join(tempRoot, item.kind, item.id);
      fs.mkdirSync(staging, { recursive: true });
      for (const file of item.files) {
        const rel = file.name.slice(item.prefix.length);
        if (!rel) continue;
        const full = path.resolve(staging, ...rel.split('/'));
        if (!full.startsWith(staging + path.sep)) throw new Error(`文件路径越界：${rel}`);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, await readEntry(zip, file.entry));
      }
    }
    const installed = [];
    try {
      for (const item of pending) {
        fs.mkdirSync(path.dirname(item.target), { recursive: true });
        fs.renameSync(path.join(tempRoot, item.kind, item.id), item.target);
        installed.push({ id: item.id, name: item.name, kind: item.kind });
      }
    } catch (error) {
      for (const item of installed) {
        const target = path.join(item.kind === 'plugins' ? plugins : skills, item.id);
        if (path.resolve(target).startsWith(resolvedRoot + path.sep)) fs.rmSync(target, { recursive: true, force: true });
      }
      throw error;
    }
    return { installed, skipped };
  } finally {
    try { zip.close(); } catch { /* ignore */ }
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
