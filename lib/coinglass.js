'use strict';
/*
 * CoinGlass 客户端（逆向自 coinclass-re，零第三方依赖）
 *
 * 协议要点：
 *   请求头 encryption:true + cache-ts-v2:<ms> + 浏览器伪装头
 *   响应头 v（密钥版本）、user（base64 双层密钥）；v=0 时 Key0 由 cache-ts-v2 派生
 *   加密：AES-128-ECB 解密 user -> gunzip -> 真实 key；再用真实 key 解密 data -> gunzip -> JSON
 *
 * 用途：仅个人看盘工具使用。数据版权归 CoinGlass，注意控制频率。
 */
const crypto = require('crypto');
const zlib = require('zlib');

const BASE = 'https://capi.coinglass.com';

// 遗留密钥表（webpack module 12471）
const LEGACY_KEY_TABLE = { 55: '170b070da9654622', 66: 'd6537d845a964081', 77: '863f08689c97435b' };

const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  encryption: 'true',
  language: 'zh',
  Origin: 'https://www.coinglass.com',
  Referer: 'https://www.coinglass.com',
  'Sec-Ch-Ua': '"Google Chrome";v="125", "Chromium";v="125"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};

// Key0 = base64(常量)[:16]，常量按 v 取值
function deriveKey0(v, ctx) {
  let constant;
  switch (String(v)) {
    case '0':
      if (!ctx.cacheTs) throw new Error('v=0 需要 cache-ts-v2');
      constant = ctx.cacheTs;
      break;
    case '1':
      if (!ctx.url) throw new Error('v=1 需要完整 URL');
      constant = new URL(ctx.url).pathname;
      break;
    case '2':
      if (!ctx.timeHeader) throw new Error('v=2 需要响应头 time');
      constant = ctx.timeHeader;
      break;
    default: {
      constant = LEGACY_KEY_TABLE[String(v)];
      if (!constant) throw new Error('未知密钥版本 v=' + v);
    }
  }
  return Buffer.from(constant, 'utf8').toString('base64').slice(0, 16);
}

function unpad(buf) {
  const padLen = buf[buf.length - 1];
  if (!padLen || padLen > 16) throw new Error('无效的 PKCS7 填充');
  return buf.subarray(0, buf.length - padLen);
}

function aesEcbDecrypt(ciphertext, key) {
  if (key.length !== 16) throw new Error('AES-128 密钥必须 16 字节，实际 ' + key.length);
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decryptResponse(body, userTokenB64, v, ctx) {
  const outer = JSON.parse(body);
  if (!outer.data) throw new Error('响应缺少 data 字段（可能不是加密端点）');
  const payload = Buffer.from(outer.data, 'base64');
  const token = Buffer.from(userTokenB64, 'base64');
  const key0 = Buffer.from(deriveKey0(v, ctx), 'utf8');

  const actualKey = zlib.gunzipSync(unpad(aesEcbDecrypt(token, key0))).toString('utf8');
  const plain = zlib.gunzipSync(unpad(aesEcbDecrypt(payload, Buffer.from(actualKey, 'utf8')))).toString('utf8');
  return JSON.parse(plain);
}

/**
 * 请求 CoinGlass 端点并自动解密（明文端点直接返回 JSON）
 * @param {string} path 形如 /api/hyperliquid/vaults
 * @param {object} [params] 查询参数
 */
async function cgFetch(path, params, timeoutMs) {
  const cacheTs = String(Date.now());
  const qs = new URLSearchParams();
  for (const k of Object.keys(params || {})) {
    if (params[k] !== undefined && params[k] !== null) qs.set(k, String(params[k]));
  }
  const fullUrl = BASE + path + (qs.toString() ? '?' + qs.toString() : '');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 20000);
  let resp;
  try {
    resp = await fetch(fullUrl, { headers: Object.assign({}, HEADERS, { 'cache-ts-v2': cacheTs }), signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' @' + path);

  const text = await resp.text();
  const user = resp.headers.get('user');
  const v = resp.headers.get('v');
  if (!user || !v) return JSON.parse(text); // 明文端点
  return decryptResponse(text, user, v, { url: fullUrl, cacheTs, timeHeader: resp.headers.get('time') || '' });
}

module.exports = { cgFetch, decryptResponse, deriveKey0 };
