/**
 * refactor/apps/server/static.js — 静态文件服务
 *
 * serve refactor/apps/ui/ 下的 index.html / style.css / assets/*。
 * 只做 IO，不做决定。路径穿越防护：resolve 后必须仍在 UI_ROOT 下。
 */
import fs from 'node:fs';
import path from 'node:path';
import { UI_ROOT } from './paths.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4'
};

/**
 * 尝试服务一个静态文件。
 * @param {string} urlPath - 请求路径（如 '/'、'/app.js'、'/assets/icon.png'）
 * @returns {{ status: number, headers: Record<string,string>, body: Buffer } | null}
 *   命中返回响应对象；未命中返回 null（调用方再走 API 路由 / 404）。
 */
export function tryServeStatic(urlPath) {
  // 只处理根绝对路径
  let rel = String(urlPath || '/').split('?')[0].split('#')[0];
  if (rel === '/' || rel === '') rel = '/index.html';

  // 解析到绝对路径，防止路径穿越
  const abs = path.resolve(UI_ROOT, '.' + path.posix.normalize(rel.replace(/\\/g, '/')));
  if (!abs.startsWith(UI_ROOT)) return null;

  let stat;
  try { stat = fs.statSync(abs); } catch { return null; }
  if (!stat.isFile()) return null;

  const ext = path.extname(abs).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const body = fs.readFileSync(abs);
  return {
    status: 200,
    headers: { 'content-type': mime, 'content-length': String(body.length) },
    body
  };
}

/** 静态根目录（供自检） */
export function staticRoot() {
  return UI_ROOT;
}
