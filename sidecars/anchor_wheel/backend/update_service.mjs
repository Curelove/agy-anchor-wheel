import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_UPDATE_RESP_BYTES = 2 * 1024 * 1024;

export function parseGithubRepo(repoUrl) {
  const raw = String(repoUrl || '').trim();
  if (!raw) return null;
  const httpsMatch = /github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(raw);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/i, '') };
  }
  const sshMatch = /github\.com:([^/\s]+)\/([^/\s#?]+)/i.exec(raw);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/i, '') };
  }
  return null;
}

function parseSemverParts(v) {
  const clean = String(v || '').trim().replace(/^v/i, '');
  const [coreRaw, preRaw = ''] = clean.split('-', 2);
  const nums = coreRaw.split('.').map((n) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  return {
    major: nums[0] || 0,
    minor: nums[1] || 0,
    patch: nums[2] || 0,
    pre: preRaw.trim(),
  };
}

export function compareSemver(a, b) {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] > pb[key]) return 1;
    if (pa[key] < pb[key]) return -1;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre > pb.pre ? 1 : -1;
}

export function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

export function extractTargetAgyFromNotes(body) {
  const text = String(body || '');
  if (!text) return '';
  const tagMatch = /<!--\s*aw-compat:\s*agy=([^\s>]+)\s*-->/i.exec(text);
  if (tagMatch?.[1]) return decodeHtmlEntities(tagMatch[1].trim());
  const plain = decodeHtmlEntities(text.replace(/<[^>]+>/g, ' '));
  const zhMatch = /(?:适配|适用|兼容)\s*(?:Antigravity|AGY)\s*[：:]\s*([^\r\n]+)/i.exec(plain);
  if (zhMatch?.[1]) {
    let picked = decodeHtmlEntities(zhMatch[1]).replace(/^[`*\s]+|[`*\s]+$/g, '');
    // Trim verbose parenthetical suffixes when a clean version/range precedes them
    const concise = /^([A-Za-z0-9.+_-]+(?:\s*[~～-]\s*[A-Za-z0-9.+_-]+)?)\s*[（(].+$/.exec(picked);
    if (concise?.[1]) picked = concise[1].trim();
    return picked.slice(0, 48);
  }
  return '';
}

function normalizeProxyString(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (s.includes('=')) {
    const parts = s.split(';').map((x) => x.trim());
    const httpsPart = parts.find((x) => /^https=/i.test(x));
    const httpPart = parts.find((x) => /^http=/i.test(x));
    const picked = httpsPart || httpPart || parts[0];
    s = picked.replace(/^[a-z]+=/i, '').trim();
  }
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname || !u.port) return '';
    return u.toString();
  } catch {
    return '';
  }
}

export function detectSystemProxyUrl() {
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  const normalizedEnv = normalizeProxyString(envProxy);
  if (normalizedEnv) return normalizedEnv;

  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg.exe',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 1500, windowsHide: true }
      );
      const enableMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
      const enabled = enableMatch ? parseInt(enableMatch[1], 16) === 1 : false;
      if (!enabled) return '';
      const srvMatch = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(out);
      return normalizeProxyString(srvMatch?.[1] || '');
    } catch {
      return '';
    }
  }
  return '';
}

function requestViaHttpConnect(targetUrl, proxyUrl, { timeoutMs = 7000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy = new URL(proxyUrl);
    const port = Number(target.port) || 443;
    const hostPort = `${target.hostname}:${port}`;

    let settled = false;
    let connectReq = null;
    let tlsSock = null;
    let httpsReq = null;

    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { connectReq?.destroy?.(); } catch {}
      try { httpsReq?.destroy?.(); } catch {}
      try { tlsSock?.destroy?.(); } catch {}
      reject(err);
    };

    const timer = setTimeout(() => {
      finishErr(new Error(`HTTPS request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: hostPort,
      headers: { Host: hostPort },
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        try { socket.destroy(); } catch {}
        finishErr(new Error(`Proxy CONNECT failed (${res.statusCode})`));
        return;
      }

      tlsSock = tls.connect({
        socket,
        servername: target.hostname,
      });

      tlsSock.once('error', finishErr);

      httpsReq = https.request(
        {
          hostname: target.hostname,
          port,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: {
            Host: target.hostname,
            'User-Agent': 'agy-anchor-wheel-updater',
            Accept: 'application/vnd.github+json',
            ...headers,
          },
          createConnection: () => tlsSock,
          agent: false,
        },
        (httpsRes) => {
          const chunks = [];
          let totalBytes = 0;
          httpsRes.on('error', finishErr);
          httpsRes.on('data', (c) => {
            totalBytes += c.length;
            if (totalBytes > MAX_UPDATE_RESP_BYTES) {
              finishErr(new Error('HTTPS response exceeded size limit'));
              return;
            }
            chunks.push(c);
          });
          httpsRes.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { tlsSock?.destroy?.(); } catch {}
            resolve({
              statusCode: httpsRes.statusCode || 0,
              headers: httpsRes.headers || {},
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );

      httpsReq.on('error', finishErr);
      httpsReq.end();
    });

    connectReq.on('error', finishErr);
    connectReq.end();
  });
}

function requestDirectHttps(targetUrl, { timeoutMs = 7000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    let settled = false;
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.destroy(); } catch {}
      reject(err);
    };
    const req = https.request(
      {
        hostname: target.hostname,
        port: Number(target.port) || 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          'User-Agent': 'agy-anchor-wheel-updater',
          Accept: 'application/vnd.github+json',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let totalBytes = 0;
        res.on('error', finishErr);
        res.on('data', (c) => {
          totalBytes += c.length;
          if (totalBytes > MAX_UPDATE_RESP_BYTES) {
            finishErr(new Error('HTTPS response exceeded size limit'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    const timer = setTimeout(() => {
      finishErr(new Error(`HTTPS request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on('error', finishErr);
    req.end();
  });
}

export async function httpsGetText(url, { proxyUrl = '', timeoutMs = 7000, headers = {}, maxRedirects = 3 } = {}) {
  let curUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let resp;
    if (proxyUrl) {
      const proxyTimeout = Math.min(timeoutMs, 4500);
      const directTimeout = Math.min(timeoutMs, 3500);
      try {
        resp = await requestViaHttpConnect(curUrl, proxyUrl, { timeoutMs: proxyTimeout, headers });
      } catch (proxyErr) {
        try {
          resp = await requestDirectHttps(curUrl, { timeoutMs: directTimeout, headers });
        } catch {
          throw proxyErr;
        }
      }
    } else {
      resp = await requestDirectHttps(curUrl, { timeoutMs, headers });
    }

    if ([301, 302, 307, 308].includes(resp.statusCode) && resp.headers?.location) {
      curUrl = new URL(resp.headers.location, curUrl).toString();
      continue;
    }

    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      const err = new Error(`HTTP ${resp.statusCode}`);
      err.statusCode = resp.statusCode;
      err.responseBody = resp.body;
      throw err;
    }

    return resp.body || '';
  }
  throw new Error('Too many redirects');
}

export async function httpsGetJson(url, opts = {}) {
  const text = await httpsGetText(url, opts);
  return JSON.parse(text || 'null');
}

function decodeXmlEntities(str) {
  return decodeHtmlEntities(str);
}

export function parseReleasesAtom(xml, fallbackRepoUrl = 'https://github.com/Curelove/agy-anchor-wheel') {
  const entryMatch = /<entry\b[^>]*>([\s\S]*?)<\/entry>/i.exec(String(xml || ''));
  if (!entryMatch) return null;
  const entryXml = entryMatch[1];

  const linkMatch = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(entryXml);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(entryXml);
  const updatedMatch = /<updated\b[^>]*>([\s\S]*?)<\/updated>/i.exec(entryXml);
  const contentMatch = /<content\b[^>]*>([\s\S]*?)<\/content>/i.exec(entryXml);
  const idMatch = /<id\b[^>]*>([\s\S]*?)<\/id>/i.exec(entryXml);

  const rawHref = linkMatch?.[1] ? decodeXmlEntities(linkMatch[1].trim()) : '';
  let releaseUrl = `${fallbackRepoUrl}/releases`;
  if (rawHref) {
    try {
      releaseUrl = new URL(rawHref, fallbackRepoUrl).toString();
    } catch {}
  }

  let tagName = '';
  const tagFromUrl = /\/releases\/tag\/([^/?#]+)/i.exec(releaseUrl);
  if (tagFromUrl?.[1]) {
    try { tagName = decodeURIComponent(tagFromUrl[1].trim()); } catch { tagName = tagFromUrl[1].trim(); }
  }
  if (!tagName && idMatch?.[1]) {
    const idSegs = idMatch[1].trim().split('/');
    tagName = idSegs[idSegs.length - 1] || '';
  }
  if (!tagName) return null;

  // Title may be double-encoded inside XML Atom feeds; decode cleanly
  const title = decodeHtmlEntities(
    decodeXmlEntities((titleMatch?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
  ).trim();
  const updated = (updatedMatch?.[1] || '').trim();
  // Pass 1: unwrap Atom XML layer -> raw HTML
  const rawHtml = decodeXmlEntities((contentMatch?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  const targetAntigravity = extractTargetAgyFromNotes(rawHtml);
  // Pass 2: strip HTML tags and decode HTML-layer entities (fixes double-encoded &gt; / &amp; / &quot;)
  const plainBody = decodeHtmlEntities(
    rawHtml
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/(?:p|li|h[1-6]|div|tr|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 900);

  return {
    tag_name: tagName,
    name: title || tagName,
    html_url: releaseUrl,
    published_at: updated,
    body: plainBody,
    targetAntigravity,
    assets: [],
    _source: 'github_atom',
  };
}

function parseUninstallBlocks(regOutput) {
  const blocks = String(regOutput || '').split(/\r?\n\r?\n+/);
  const found = [];
  for (const blk of blocks) {
    const keyMatch = /^(HKEY_[^\r\n]+)/im.exec(blk.trim());
    const nameMatch = /DisplayName\s+REG_SZ\s+([^\r\n]+)/i.exec(blk);
    const verMatch = /DisplayVersion\s+REG_SZ\s+([^\r\n]+)/i.exec(blk);
    if (!nameMatch) continue;
    const keyPath = keyMatch ? keyMatch[1].trim() : '';
    const displayName = nameMatch[1].trim();
    let displayVersion = verMatch ? verMatch[1].trim() : '';
    if (!displayVersion && keyPath) {
      try {
        const verOut = execFileSync('reg.exe', ['query', keyPath, '/v', 'DisplayVersion'], {
          encoding: 'utf8',
          timeout: 1200,
          windowsHide: true,
        });
        const m = /DisplayVersion\s+REG_SZ\s+([^\r\n]+)/i.exec(verOut);
        if (m?.[1]) displayVersion = m[1].trim();
      } catch {}
    }
    if (!displayVersion) {
      const mVer = /\b(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?)\b/.exec(displayName);
      if (mVer?.[1]) displayVersion = mVer[1];
    }
    if (/^Antigravity(?:\s|$)/i.test(displayName) && displayVersion) {
      found.push({ displayName, displayVersion });
    }
  }
  return found;
}

export function evaluateCompatibility(installedVersion, compatibility = {}) {
  const testedVersions = Array.isArray(compatibility?.testedAntigravityVersions)
    ? compatibility.testedAntigravityVersions.map((v) => String(v))
    : [];
  const testedRange = String(compatibility?.testedRange || testedVersions.join(', ') || '');
  const notice = String(compatibility?.nativeEnhancerNotice || '');

  if (!installedVersion) {
    return {
      installedVersion: '',
      testedVersions,
      testedRange,
      compatLevel: 'unknown',
      nativeEnhancerNotice: notice,
    };
  }

  const inst = parseSemverParts(installedVersion);
  const exactOrMinor = testedVersions.some((tv) => {
    const tp = parseSemverParts(tv);
    return inst.major === tp.major && inst.minor === tp.minor;
  });
  if (exactOrMinor) {
    return {
      installedVersion,
      testedVersions,
      testedRange,
      compatLevel: 'verified',
      nativeEnhancerNotice: notice,
    };
  }

  const sameMajor = testedVersions.some((tv) => parseSemverParts(tv).major === inst.major);
  return {
    installedVersion,
    testedVersions,
    testedRange,
    compatLevel: sameMajor ? 'same_major' : 'untested',
    nativeEnhancerNotice: notice,
  };
}

export function detectInstalledAntigravityVersion(compatibility = {}) {
  let installedVersion = '';
  if (process.platform === 'win32') {
    const roots = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    const entries = [];
    for (const root of roots) {
      try {
        const out = execFileSync('reg.exe', ['query', root, '/s', '/f', 'Antigravity', '/d'], {
          encoding: 'utf8',
          timeout: 1800,
          windowsHide: true,
        });
        entries.push(...parseUninstallBlocks(out));
        if (entries.some((e) => !/\bIDE\b/i.test(e.displayName))) break;
      } catch {
        // Ignore missing/blocked registry hive
      }
    }
    const primary = entries.find((e) => !/\bIDE\b/i.test(e.displayName)) || entries[0];
    if (primary) installedVersion = primary.displayVersion;
  }
  return evaluateCompatibility(installedVersion, compatibility);
}

export class UpdateService {
  constructor({
    dataDir,
    pluginRoot = DEFAULT_PLUGIN_ROOT,
    fetchJsonImpl = null,
    fetchTextImpl = null,
    detectAgyImpl = null,
    detectProxyImpl = null,
  } = {}) {
    this.dataDir = dataDir;
    this.pluginRoot = pluginRoot;
    this.cachePath = dataDir ? path.join(dataDir, 'update_cache.json') : '';
    this.fetchJsonImpl = fetchJsonImpl;
    this.fetchTextImpl = fetchTextImpl;
    this.detectAgyImpl = detectAgyImpl;
    this.detectProxyImpl = detectProxyImpl;
    this._localAgyCache = null;
    this._localAgyAt = 0;
    this._inflightCheck = null;
  }

  readManifest() {
    try {
      const p = path.join(this.pluginRoot, 'plugin.json');
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return {
        name: 'agy-anchor-wheel',
        version: '0.0.0',
        repository: { url: 'https://github.com/Curelove/agy-anchor-wheel' },
      };
    }
  }

  readCompatibility(manifest = null) {
    const candidates = [
      path.join(this.pluginRoot, 'sidecars', 'anchor_wheel', 'compatibility.json'),
      path.join(this.pluginRoot, 'compatibility.json'),
    ];
    for (const filePath of candidates) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // ignore malformed or unreadable fallback file
      }
    }
    if (manifest?.compatibility && typeof manifest.compatibility === 'object' && !Array.isArray(manifest.compatibility)) {
      return manifest.compatibility;
    }
    return {};
  }

  getLocalCompatibility(compatibility) {
    const now = Date.now();
    if (this._localAgyCache && now - this._localAgyAt < 10 * 60 * 1000) {
      return evaluateCompatibility(this._localAgyCache.installedVersion, compatibility);
    }
    const res = this.detectAgyImpl
      ? evaluateCompatibility(this.detectAgyImpl(), compatibility)
      : detectInstalledAntigravityVersion(compatibility);
    this._localAgyCache = res;
    this._localAgyAt = now;
    return res;
  }

  getPluginMeta() {
    const mf = this.readManifest();
    const version = String(mf.version || '0.0.0');
    const rawRepoUrl = typeof mf.repository === 'string' ? mf.repository : mf.repository?.url;
    const repoUrl = String(rawRepoUrl || 'https://github.com/Curelove/agy-anchor-wheel').replace(/\.git$/i, '');
    const parsed = parseGithubRepo(repoUrl) || { owner: 'Curelove', repo: 'agy-anchor-wheel' };
    const compatibility = this.readCompatibility(mf);
    return {
      name: mf.name || 'agy-anchor-wheel',
      version,
      repoUrl,
      releasesUrl: `${repoUrl}/releases`,
      owner: parsed.owner,
      repo: parsed.repo,
      compatibility,
      localAntigravity: this.getLocalCompatibility(compatibility),
    };
  }

  _readCacheFile() {
    if (!this.cachePath) return null;
    try {
      if (!fs.existsSync(this.cachePath)) return null;
      return JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
    } catch {
      return null;
    }
  }

  _writeCacheFile(obj) {
    if (!this.cachePath) return;
    const tmp = `${this.cachePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const payload = JSON.stringify(obj, null, 2) + '\n';
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.cachePath);
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      try { fs.writeFileSync(this.cachePath, payload, 'utf8'); } catch {}
    }
  }

  getCachedResult() {
    const meta = this.getPluginMeta();
    const cached = this._readCacheFile();
    if (!cached || !cached.latestVersion) return null;
    const updateAvailable = compareSemver(cached.latestVersion, meta.version) > 0;
    const cleanTargetAgy = cached.targetAntigravity ? decodeHtmlEntities(cached.targetAntigravity) : '';
    const cleanSnippet = cached.bodySnippet ? decodeHtmlEntities(cached.bodySnippet) : '';
    return {
      ...cached,
      targetAntigravity: cleanTargetAgy,
      bodySnippet: cleanSnippet,
      currentVersion: meta.version,
      updateAvailable,
      repoUrl: meta.repoUrl,
      releasesUrl: meta.releasesUrl,
      compatibility: meta.compatibility,
      localAntigravity: meta.localAntigravity,
      fromCache: true,
    };
  }

  async _fetchGithubJson(url) {
    const proxyUrl = this.detectProxyImpl ? this.detectProxyImpl() : detectSystemProxyUrl();
    if (this.fetchJsonImpl) {
      return this.fetchJsonImpl(url, { proxyUrl });
    }
    return httpsGetJson(url, { proxyUrl, timeoutMs: 7000 });
  }

  async _fetchGithubText(url) {
    const proxyUrl = this.detectProxyImpl ? this.detectProxyImpl() : detectSystemProxyUrl();
    if (this.fetchTextImpl) {
      return this.fetchTextImpl(url, { proxyUrl });
    }
    return httpsGetText(url, {
      proxyUrl,
      timeoutMs: 7000,
      headers: { Accept: 'application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.8' },
    });
  }

  async checkForUpdates({ force = false } = {}) {
    const meta = this.getPluginMeta();
    if (!force) {
      const cached = this.getCachedResult();
      if (cached && cached.checkedAt && Date.now() - Number(cached.checkedAt) < CACHE_TTL_MS && cached.repoUrl === meta.repoUrl) {
        return cached;
      }
    }
    if (this._inflightCheck) {
      return this._inflightCheck;
    }
    const run = this._performCheckForUpdates(meta).finally(() => {
      if (this._inflightCheck === run) this._inflightCheck = null;
    });
    this._inflightCheck = run;
    return run;
  }

  async _performCheckForUpdates(meta) {

    const latestApi = `https://api.github.com/repos/${meta.owner}/${meta.repo}/releases/latest`;
    const listApi = `https://api.github.com/repos/${meta.owner}/${meta.repo}/releases?per_page=1`;
    const atomUrl = `${meta.repoUrl}/releases.atom`;
    const checkedAt = Date.now();

    try {
      let release = null;
      let apiErr = null;
      try {
        release = await this._fetchGithubJson(latestApi);
      } catch (err) {
        if (err?.statusCode === 404) {
          const list = await this._fetchGithubJson(listApi).catch(() => null);
          if (Array.isArray(list) && list.length > 0) {
            release = list[0];
          }
        } else {
          apiErr = err;
        }
      }

      // Fallback to GitHub Releases Atom feed whenever API hits rate limit (403/429), fails, or returns empty
      let atomEmptyConfirmed = false;
      if (!release || !release.tag_name) {
        try {
          const atomXml = await this._fetchGithubText(atomUrl);
          const atomRelease = parseReleasesAtom(atomXml, meta.repoUrl);
          if (atomRelease && atomRelease.tag_name) {
            release = atomRelease;
            apiErr = null;
          } else {
            atomEmptyConfirmed = true;
            apiErr = null;
          }
        } catch (atomErr) {
          if (!apiErr) apiErr = atomErr;
        }
      }

      if (apiErr) throw apiErr;

      if (!release || !release.tag_name || atomEmptyConfirmed) {
        return {
          ok: false,
          noReleases: true,
          error: 'GitHub 仓库暂未发布正式 Release',
          currentVersion: meta.version,
          repoUrl: meta.repoUrl,
          releasesUrl: meta.releasesUrl,
          compatibility: meta.compatibility,
          localAntigravity: meta.localAntigravity,
          checkedAt,
        };
      }

      const tagName = String(release.tag_name || '').trim();
      const latestVersion = tagName.replace(/^v/i, '');
      const bodyRaw = String(release.body || '');
      const bodySnippet = bodyRaw
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim()
        .slice(0, 900);
      const assets = Array.isArray(release.assets)
        ? release.assets.slice(0, 6).map((a) => ({
            name: String(a.name || ''),
            size: Number(a.size || 0),
            downloadUrl: String(a.browser_download_url || ''),
          }))
        : [];

      const result = {
        ok: true,
        source: release._source || 'github_api',
        currentVersion: meta.version,
        latestVersion,
        tagName,
        releaseName: String(release.name || tagName),
        updateAvailable: compareSemver(latestVersion, meta.version) > 0,
        releaseUrl: String(release.html_url || meta.releasesUrl),
        publishedAt: String(release.published_at || ''),
        targetAntigravity: release.targetAntigravity || extractTargetAgyFromNotes(bodyRaw),
        bodySnippet,
        assets,
        repoUrl: meta.repoUrl,
        releasesUrl: meta.releasesUrl,
        compatibility: meta.compatibility,
        localAntigravity: meta.localAntigravity,
        checkedAt,
        fromCache: false,
      };

      this._writeCacheFile(result);
      return result;
    } catch (err) {
      const msg = String(err?.message || err || '网络请求失败');
      return {
        ok: false,
        error: msg.includes('403') ? 'GitHub API 请求频率受限，可稍后再试或直接打开 Releases 页面查看' : `无法连接 GitHub（${msg}）`,
        currentVersion: meta.version,
        repoUrl: meta.repoUrl,
        releasesUrl: meta.releasesUrl,
        compatibility: meta.compatibility,
        localAntigravity: meta.localAntigravity,
        checkedAt,
      };
    }
  }
}
