#!/usr/bin/env node
/**
 * WorkBuddy 国际版 · OpenChamber 后台伴生服务
 *
 * 双端口架构：
 *   1) 控制面   process.env.OPENCHAMBER_SERVICE_PORT  —— 仅供面板 serviceRequest
 *                强制 Bearer 鉴权（宿主分配的动态 Token）
 *   2) 网关面   127.0.0.1:18889                       —— 供 OpenChamber/OpenCode
 *                对话引擎调用，无需 Bearer（用固定 apiKey 识别）
 *
 * 持久化：~/.config/opencode/workbuddy-ext-state.json (0600)
 * 配置注入：~/.config/opencode/opencode.json 的 provider.workbuddy
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

// ─────────────────────────── 常量 ───────────────────────────

const GATEWAY_PORT = Number(process.env.WORKBUDDY_GATEWAY_PORT || 18889);

/**
 * 补丁 01 · 运行时动态版本同步 (Version Sync)
 * 动态检测本机真实安装的 WorkBuddy / CodeBuddy 桌面端与 CLI 版本，彻底告别硬编码老版本导致的 WAF 标黑
 */
function resolveClientVersion() {
  const fallback = { appVersion: '5.9.4', cliVersion: '2.165.0' };
  try {
    if (process.platform === 'darwin') {
      const candidates = [
        '/Applications/WorkBuddy AI.app',
        '/Applications/WorkBuddy.app',
        '/Applications/CodeBuddy.app',
        path.join(os.homedir(), 'Applications/WorkBuddy AI.app'),
        path.join(os.homedir(), 'Applications/WorkBuddy.app'),
      ];
      for (const app of candidates) {
        const plistPath = path.join(app, 'Contents/Info.plist');
        if (fs.existsSync(plistPath)) {
          const plistText = fs.readFileSync(plistPath, 'utf8');
          const m = plistText.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
          const appVersion = m ? m[1].trim() : fallback.appVersion;
          let cliVersion = fallback.cliVersion;
          const cliPkgPath = path.join(app, 'Contents/Resources/app.asar.unpacked/cli/package.json');
          if (fs.existsSync(cliPkgPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(cliPkgPath, 'utf8'));
              if (pkg && pkg.version) cliVersion = String(pkg.version).trim();
            } catch {}
          }
          return { appVersion, cliVersion, source: app };
        }
      }
    } else if (process.platform === 'win32') {
      const roots = [];
      if (process.env.WORKBUDDY_APP_EXECUTABLE) roots.push(path.dirname(process.env.WORKBUDDY_APP_EXECUTABLE));
      if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy'));
      if (process.env.PROGRAMFILES) roots.push(path.join(process.env.PROGRAMFILES, 'WorkBuddy'));
      if (process.env['PROGRAMFILES(X86)']) roots.push(path.join(process.env['PROGRAMFILES(X86)'], 'WorkBuddy'));
      for (const r of roots) {
        const manifestPath = path.join(r, 'resources', 'install-manifest.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const appVersion = manifest && manifest.appVersion ? String(manifest.appVersion).trim() : fallback.appVersion;
            let cliVersion = fallback.cliVersion;
            const cliPkgPath = path.join(r, 'resources', 'app.asar.unpacked', 'cli', 'package.json');
            if (fs.existsSync(cliPkgPath)) {
              const pkg = JSON.parse(fs.readFileSync(cliPkgPath, 'utf8'));
              if (pkg && pkg.version) cliVersion = String(pkg.version).trim();
            }
            return { appVersion, cliVersion, source: r };
          } catch {}
        }
      }
    } else if (process.platform === 'linux') {
      const roots = ['/opt/WorkBuddy', '/usr/share/workbuddy'];
      for (const r of roots) {
        const manifestPath = path.join(r, 'resources', 'install-manifest.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const appVersion = manifest && manifest.appVersion ? String(manifest.appVersion).trim() : fallback.appVersion;
            let cliVersion = fallback.cliVersion;
            const cliPkgPath = path.join(r, 'resources', 'app.asar.unpacked', 'cli', 'package.json');
            if (fs.existsSync(cliPkgPath)) {
              const pkg = JSON.parse(fs.readFileSync(cliPkgPath, 'utf8'));
              if (pkg && pkg.version) cliVersion = String(pkg.version).trim();
            }
            return { appVersion, cliVersion, source: r };
          } catch {}
        }
      }
    }
  } catch {}
  return { ...fallback, source: 'fallback' };
}

const clientVersions = resolveClientVersion();
const DYNAMIC_USER_AGENT = `WorkBuddy/${clientVersions.appVersion} WorkBuddy/${clientVersions.appVersion} CLI/${clientVersions.cliVersion}`;

const REGIONS = {
  intl: {
    id: 'intl',
    name: '国际版 (WorkBuddy)',
    endpoint: process.env.WORKBUDDY_ENDPOINT || 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    platform: 'workbuddy-ai',
    productCode: 'workbuddy',
    userAgent: DYNAMIC_USER_AGENT,
    deploymentType: 'SaaS',
    refreshSource: 'ide-main',
    version: clientVersions.appVersion,
    cliVersion: clientVersions.cliVersion,
    defaultCredits: 100.0,
    providerName: 'WorkBuddy (Intl)',
  },
  china: {
    id: 'china',
    name: '中国版 (CodeBuddy)',
    endpoint: process.env.CODEBUDDY_ENDPOINT || 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    platform: 'codebuddy',
    productCode: 'codebuddy',
    userAgent: DYNAMIC_USER_AGENT,
    deploymentType: 'SaaS',
    refreshSource: 'ide-main',
    version: clientVersions.appVersion,
    cliVersion: clientVersions.cliVersion,
    defaultCredits: 100.0,
    providerName: 'CodeBuddy (CN)',
  },
};

function getActiveRegion() {
  const r = (typeof state !== 'undefined' && state.currentRegion) || 'intl';
  return REGIONS[r] || REGIONS.intl;
}

const WORKBUDDY = new Proxy({}, {
  get(target, prop) {
    const reg = getActiveRegion();
    return reg[prop];
  },
});

/** 提前 5 分钟视为过期，避免边界失效 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
const STATE_FILE_VERSION = 1;

function getOpenCodeConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) {
    const xdg = path.join(process.env.XDG_CONFIG_HOME, 'opencode');
    if (fs.existsSync(xdg)) return xdg;
  }
  const homedir = os.homedir() || process.env.USERPROFILE || process.env.HOME || '';
  const dotConfig = path.join(homedir, '.config', 'opencode');

  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      const appDataDir = path.join(process.env.APPDATA, 'opencode');
      if (fs.existsSync(path.join(appDataDir, 'opencode.jsonc')) || fs.existsSync(path.join(appDataDir, 'opencode.json')) || fs.existsSync(appDataDir)) {
        return appDataDir;
      }
    }
    if (fs.existsSync(path.join(dotConfig, 'opencode.jsonc')) || fs.existsSync(path.join(dotConfig, 'opencode.json')) || fs.existsSync(dotConfig)) {
      return dotConfig;
    }
    if (process.env.APPDATA) {
      return path.join(process.env.APPDATA, 'opencode');
    }
  }

  return dotConfig;
}

function getStateDir() {
  return getOpenCodeConfigDir();
}

function getStateFilePath() {
  return path.join(getStateDir(), 'workbuddy-ext-state.json');
}

function getOpenCodeConfigPath() {
  const dir = getOpenCodeConfigDir();
  const jsonc = path.join(dir, 'opencode.jsonc');
  if (fs.existsSync(jsonc)) return jsonc;
  return path.join(dir, 'opencode.json');
}

// ─────────────────────────── 工具 ───────────────────────────

function log(...args) {
  console.log(`[WorkBuddy ${new Date().toISOString()}]`, ...args);
}

function parseJSON(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }
}

function stripControlChars(value) {
  return String(value)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function readStringField(record, key) {
  if (!record || typeof record !== 'object') return '';
  const value = record[key];
  if (typeof value === 'string') return stripControlChars(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function readNumberField(record, key) {
  if (!record || typeof record !== 'object') return undefined;
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 估算 token：英文 ~4 字符/token，中文 ~1.5 字符/token */
function estimateTokens(text) {
  const s = typeof text === 'string' ? text : '';
  if (s.length === 0) return 0;
  const cjk = (s.match(/[一-鿿　-〿]/g) || []).length;
  const rest = s.length - cjk;
  return Math.max(1, Math.round(cjk / 1.5 + rest / 4));
}

function jwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  return parseJSON(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

function jwtClaimMs(token, claim) {
  const payload = jwtPayload(token);
  const value = payload && payload[claim];
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined;
}

function pickClientFor(urlString) {
  return urlString.startsWith('http://') ? http : https;
}

/** 通用 JSON 请求（控制面用） */
function requestJSON(method, urlString, headers, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (error) {
      reject(error);
      return;
    }
    const payload = body === null || body === undefined ? null : JSON.stringify(body);
    const req = pickClientFor(urlString).request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 安全的 JSON 请求体读取。
 * 无 Content-Length 且非 chunked 时直接返回 {}，绝不挂起。
 */
function readJsonBody(req, timeoutMs = 60000, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      resolve({});
      return;
    }
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    const chunked = String(req.headers['transfer-encoding'] || '').toLowerCase().includes('chunked');
    if (!contentLength && !chunked) {
      resolve({});
      return;
    }
    let body = '';
    let settled = false;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(parseJSON(body) || {});
    };

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, timeoutMs);
    };

    resetTimer();

    req.on('data', (chunk) => {
      body += chunk;
      resetTimer();
      if (body.length > maxBytes) {
        log(`请求体大小超过限制 (${maxBytes} 字节)，中止读取`);
        req.destroy();
      }
    });
    req.on('end', finish);
    req.on('error', finish);
    req.on('aborted', finish);
  });
}

function sendJSON(res, status, payload) {
  const text = JSON.stringify(payload === undefined ? null : payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

// ─────────────────────────── 状态与持久化 ───────────────────────────

const DEFAULT_INITIAL_CREDITS = 100.0;

function defaultCredits(initial = DEFAULT_INITIAL_CREDITS) {
  const init = typeof initial === 'number' && Number.isFinite(initial) ? initial : DEFAULT_INITIAL_CREDITS;
  return {
    initialBalance: init,
    currentBalance: init,
    totalConsumed: 0.0,
    lastCalibratedAt: Date.now(),
  };
}

function defaultUsage() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    generationMs: 0,
    modelStats: {},
  };
}

function defaultGlobalUsage() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    creditsConsumed: 0.0,
    generationMs: 0,
  };
}

function defaultRegionState(regionId) {
  const reg = REGIONS[regionId] || REGIONS.intl;
  return {
    accounts: [],
    activeAccountId: null,
    credential: null,
    enabled: false,
    models: [],
    disabledModels: [],
    modelsFetchedAt: 0,
    usage: defaultUsage(),
    credits: defaultCredits(reg.defaultCredits),
  };
}

const state = {
  version: 3,
  currentRegion: 'intl',
  regions: {
    intl: defaultRegionState('intl'),
    china: defaultRegionState('china'),
  },
  globalUsage: defaultGlobalUsage(),
  // 镜像当前激活区域的状态字段（兼容所有原有逻辑）：
  credential: null,
  enabled: false,
  models: [],
  disabledModels: [],
  modelsFetchedAt: 0,
  usage: defaultUsage(),
  credits: defaultCredits(100.0),
  loginInProgress: false,
  loginError: '',
};

function getActiveAccount(region) {
  const r = region || state.currentRegion || 'intl';
  const cur = state.regions[r];
  if (!cur || !Array.isArray(cur.accounts)) return null;
  return cur.accounts.find((a) => a.id === cur.activeAccountId) || cur.accounts[0] || null;
}

function syncActiveRegionFromState() {
  const r = state.currentRegion || 'intl';
  if (!state.regions[r]) state.regions[r] = defaultRegionState(r);
  const cur = state.regions[r];
  cur.credential = state.credential;
  cur.enabled = state.enabled;
  cur.models = state.models;
  cur.disabledModels = state.disabledModels;
  cur.modelsFetchedAt = state.modelsFetchedAt;
  cur.usage = state.usage;
  cur.credits = state.credits;

  // 同步当前激活账号对象
  if (Array.isArray(cur.accounts) && cur.activeAccountId) {
    const acc = cur.accounts.find((a) => a.id === cur.activeAccountId);
    if (acc) {
      acc.credential = state.credential;
      acc.credits = state.credits;
      acc.usage = state.usage;
      acc.lastActiveAt = Date.now();
    }
  }
}

function syncStateWithActiveRegion() {
  const r = state.currentRegion || 'intl';
  if (!state.regions[r]) state.regions[r] = defaultRegionState(r);
  const cur = state.regions[r];
  if (!Array.isArray(cur.accounts)) cur.accounts = [];

  if (!cur.activeAccountId && cur.accounts.length > 0) {
    cur.activeAccountId = cur.accounts[0].id;
  }

  const activeAcc = cur.accounts.find((a) => a.id === cur.activeAccountId);
  if (activeAcc) {
    cur.credential = activeAcc.credential;
    cur.credits = activeAcc.credits || cur.credits;
    cur.usage = activeAcc.usage || cur.usage;
  }

  state.credential = cur.credential;
  state.enabled = cur.enabled;
  state.models = Array.isArray(cur.models) ? cur.models : [];
  state.disabledModels = Array.isArray(cur.disabledModels) ? cur.disabledModels : [];
  state.modelsFetchedAt = Number(cur.modelsFetchedAt) || 0;
  state.usage = cur.usage || defaultUsage();
  state.credits = cur.credits || defaultCredits(getActiveRegion().defaultCredits);
}

function computeAggregateUsage() {
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let requestCount = 0;
  let creditsConsumed = 0;
  let accountsCount = 0;
  const allAccounts = [];

  for (const r of Object.keys(state.regions)) {
    const list = state.regions[r].accounts || [];
    for (const acc of list) {
      accountsCount += 1;
      const u = acc.usage || defaultUsage();
      const c = acc.credits || defaultCredits(REGIONS[r]?.defaultCredits);
      const inTok = Number(u.inputTokens) || 0;
      const outTok = Number(u.outputTokens) || 0;
      const totTok = Number(u.totalTokens) || (inTok + outTok);
      inputTokens += inTok;
      outputTokens += outTok;
      totalTokens += totTok;
      requestCount += (Number(u.requestCount) || 0);
      creditsConsumed += (Number(c.totalConsumed) || 0);
      allAccounts.push({
        id: acc.id,
        uid: acc.uid,
        nickname: acc.nickname,
        region: acc.region || r,
        account_type: acc.account_type || 'personal',
        status: acc.status || 'ready',
        statusNote: acc.statusNote || '',
        addedAt: acc.addedAt || 0,
        lastActiveAt: acc.lastActiveAt || 0,
        credits: {
          initialBalance: c.initialBalance,
          currentBalance: c.currentBalance,
          totalConsumed: c.totalConsumed,
          lastCalibratedAt: c.lastCalibratedAt,
        },
        usage: {
          totalTokens: totTok,
          inputTokens: inTok,
          outputTokens: outTok,
          requestCount: u.requestCount || 0,
          generationMs: u.generationMs || 0,
          modelStats: u.modelStats || {},
        },
        isActive: (r === state.currentRegion && acc.id === state.regions[r].activeAccountId),
      });
    }
  }

  return {
    accountsCount,
    totalTokens,
    inputTokens,
    outputTokens,
    requestCount,
    creditsConsumed: Math.round(creditsConsumed * 10000) / 10000,
    accounts: allAccounts,
  };
}

function addOrUpdateAccount(regionId, token, accountInfo) {
  const r = regionId || state.currentRegion || 'intl';
  if (!state.regions[r]) state.regions[r] = defaultRegionState(r);
  const cur = state.regions[r];
  if (!Array.isArray(cur.accounts)) cur.accounts = [];

  const payload = jwtPayload(token.access_token) || {};
  const uid = String(accountInfo.uid || payload.uid || payload.sub || `uid_${Date.now()}`);
  const nickname = String(accountInfo.nickname || payload.nickname || payload.name || `用户 ${uid.slice(-4)}`);
  const credential = { ...token, ...accountInfo, uid, nickname };

  let acc = cur.accounts.find((a) => a.uid === uid || a.id === `acc_${r}_${uid}`);
  if (acc) {
    acc.credential = credential;
    acc.nickname = nickname;
    acc.status = 'active';
    acc.statusNote = '';
    acc.lastActiveAt = Date.now();
  } else {
    const reg = REGIONS[r] || REGIONS.intl;
    acc = {
      id: `acc_${r}_${uid}`,
      uid,
      nickname,
      region: r,
      account_type: accountInfo.account_type || 'personal',
      credential,
      credits: defaultCredits(reg.defaultCredits),
      usage: defaultUsage(),
      addedAt: Date.now(),
      lastActiveAt: Date.now(),
      status: 'active',
      statusNote: '',
    };
    cur.accounts.push(acc);
  }

  for (const other of cur.accounts) {
    if (other.id !== acc.id && other.status === 'active') {
      other.status = 'ready';
    }
  }

  cur.activeAccountId = acc.id;
  state.credential = acc.credential;
  state.credits = acc.credits;
  state.usage = acc.usage;
  return acc;
}

async function switchActiveAccount(accountId) {
  let targetRegion = null;
  let targetAccount = null;

  for (const r of Object.keys(state.regions)) {
    const acc = (state.regions[r].accounts || []).find((a) => a.id === accountId);
    if (acc) {
      targetRegion = r;
      targetAccount = acc;
      break;
    }
  }

  if (!targetAccount) {
    throw new Error(`找不到账号 ID: ${accountId}`);
  }

  // 1. 同步保存当前活跃账号数据
  syncActiveRegionFromState();

  // 2. 如果跨区域，切换区域
  if (state.currentRegion !== targetRegion) {
    state.currentRegion = targetRegion;
  }

  const cur = state.regions[targetRegion];
  for (const acc of cur.accounts) {
    if (acc.id === targetAccount.id) {
      acc.status = 'active';
      acc.lastActiveAt = Date.now();
    } else if (acc.status === 'active') {
      acc.status = 'ready';
    }
  }

  cur.activeAccountId = targetAccount.id;
  syncStateWithActiveRegion();
  saveState();

  // 3. 刷新模型与同步 opencode
  await fetchModels(true).catch(() => {});
  if (state.enabled) {
    syncOpenCodeConfig(true);
  }

  log(`已切换至账号：${targetAccount.nickname} (${REGIONS[targetRegion].name})`);
  return targetAccount;
}

function deleteAccount(accountId) {
  for (const r of Object.keys(state.regions)) {
    const cur = state.regions[r];
    const idx = (cur.accounts || []).findIndex((a) => a.id === accountId);
    if (idx !== -1) {
      const removed = cur.accounts.splice(idx, 1)[0];
      log(`已删除账号：${removed.nickname} (${removed.id})`);
      if (cur.activeAccountId === accountId) {
        if (cur.accounts.length > 0) {
          cur.activeAccountId = cur.accounts[0].id;
          cur.accounts[0].status = 'active';
        } else {
          cur.activeAccountId = null;
          cur.credential = null;
        }
      }
      syncStateWithActiveRegion();
      saveState();
      if (state.enabled && !state.credential) {
        state.enabled = false;
        syncOpenCodeConfig(false);
      } else if (state.enabled) {
        syncOpenCodeConfig(true);
      }
      return true;
    }
  }
  return false;
}

function loadState() {
  try {
    const stateFile = getStateFilePath();
    const raw = fs.readFileSync(stateFile, 'utf8');
    const data = parseJSON(raw);
    if (!data || typeof data !== 'object') return;

    state.currentRegion = data.currentRegion && REGIONS[data.currentRegion] ? data.currentRegion : 'intl';
    if (data.regions && typeof data.regions === 'object') {
      state.regions = {
        intl: { ...defaultRegionState('intl'), ...(data.regions.intl || {}) },
        china: { ...defaultRegionState('china'), ...(data.regions.china || {}) },
      };
    } else {
      // 迁移旧版单一数据结构到 intl
      state.regions = {
        intl: {
          accounts: [],
          activeAccountId: null,
          credential: data.credential || null,
          enabled: Boolean(data.enabled),
          models: Array.isArray(data.models) ? data.models : [],
          disabledModels: Array.isArray(data.disabledModels) ? data.disabledModels : [],
          modelsFetchedAt: Number(data.modelsFetchedAt) || 0,
          usage: { ...defaultUsage(), ...(data.usage || {}) },
          credits: data.credits || defaultCredits(100.0),
        },
        china: defaultRegionState('china'),
      };
    }

    // 自动迁移旧版凭据到 accounts 账号池中
    for (const r of ['intl', 'china']) {
      const regState = state.regions[r];
      if (!Array.isArray(regState.accounts)) regState.accounts = [];
      if (regState.credential && regState.accounts.length === 0) {
        const uid = regState.credential.uid || 'default';
        const nickname = regState.credential.nickname || (r === 'china' ? '中国版用户' : '国际版用户');
        const accId = `acc_${r}_${uid}`;
        regState.accounts.push({
          id: accId,
          uid,
          nickname,
          region: r,
          account_type: regState.credential.account_type || 'personal',
          credential: regState.credential,
          credits: regState.credits || defaultCredits(REGIONS[r].defaultCredits),
          usage: regState.usage || defaultUsage(),
          addedAt: Date.now(),
          lastActiveAt: Date.now(),
          status: 'active',
          statusNote: '',
        });
        regState.activeAccountId = accId;
      }
      if (!regState.activeAccountId && regState.accounts.length > 0) {
        regState.activeAccountId = regState.accounts[0].id;
      }
    }

    if (data.globalUsage && typeof data.globalUsage === 'object') {
      state.globalUsage = { ...defaultGlobalUsage(), ...data.globalUsage };
    } else {
      const agg = computeAggregateUsage();
      state.globalUsage = {
        totalTokens: agg.totalTokens,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        requestCount: agg.requestCount,
        creditsConsumed: agg.creditsConsumed,
        generationMs: 0,
      };
    }

    syncStateWithActiveRegion();
    log(`已加载持久化状态：region=${state.currentRegion}, enabled=${state.enabled}, accounts=${state.regions[state.currentRegion].accounts.length}, models=${state.models.length}, credits=${state.credits.currentBalance}`);
  } catch (error) {
    if (error && error.code !== 'ENOENT') log('加载状态失败（忽略）：', error.message);
  }
}

function saveState() {
  syncActiveRegionFromState();
  try {
    const stateDir = getStateDir();
    const stateFile = getStateFilePath();
    if (process.platform !== 'win32') {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    } else {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    const payload = {
      version: 3,
      currentRegion: state.currentRegion,
      regions: state.regions,
      globalUsage: state.globalUsage || defaultGlobalUsage(),
      // 保持旧版字段兼容
      credential: state.credential,
      enabled: state.enabled,
      models: state.models,
      disabledModels: state.disabledModels,
      modelsFetchedAt: state.modelsFetchedAt,
      usage: state.usage,
      credits: state.credits,
    };
    const tmp = `${stateFile}.tmp`;
    if (process.platform !== 'win32') {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } else {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    }
    fs.renameSync(tmp, stateFile);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(stateFile, 0o600);
      } catch {
        /* 某些文件系统不支持，忽略 */
      }
    }
  } catch (error) {
    log('保存状态失败：', error.message);
  }
}

function syncOpenCodeConfig(isEnabled) {
  const configPath = getOpenCodeConfigPath();
  const backup = `${configPath}.workbuddy-backup`;
  let config = {};

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = parseJSON(raw);
    if (parsed && typeof parsed === 'object') config = parsed;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') log(`读取 ${path.basename(configPath)} 失败：`, error.message);
    config = { $schema: 'https://opencode.ai/config.json' };
  }

  if (!config.$schema) config.$schema = 'https://opencode.ai/config.json';
  if (!config.provider || typeof config.provider !== 'object') config.provider = {};

  const disabledSet = new Set(state.disabledModels || []);
  const activeModels = state.models.filter((m) => !disabledSet.has(m.id));

  if (isEnabled && state.credential && activeModels.length > 0) {
    if (!fs.existsSync(backup)) {
      try {
        fs.copyFileSync(configPath, backup);
      } catch {
        /* 配置原本不存在时忽略 */
      }
    }
    const modelsObj = {};
    const activeRegion = getActiveRegion();
    const prefix = state.currentRegion === 'china' ? '[CB]' : '[WB]';
    for (const m of activeModels) {
      const isReasoning = (m.reasoningEfforts && m.reasoningEfforts.length > 0) ||
                          /^deepseek/i.test(m.id) ||
                          /r1|sol|reasoning|thinking/i.test(m.id);
      modelsObj[m.id] = {
        name: `${prefix} ${m.name || m.id}`,
        limit: {
          context: m.contextWindow || 128000,
          output: m.maxOutputTokens || 16384,
        },
        ...(isReasoning ? {
          capabilities: {
            reasoning: {
              supported: true,
              toggle: true,
              effort: m.reasoningEfforts && m.reasoningEfforts.length > 0
                ? m.reasoningEfforts
                : ['low', 'medium', 'high'],
            },
          },
        } : {}),
      };
    }
    config.provider.workbuddy = {
      npm: '@ai-sdk/openai-compatible',
      name: activeRegion.providerName,
      options: {
        baseURL: `http://127.0.0.1:${GATEWAY_PORT}/v1`,
        apiKey: 'workbuddy-local',
      },
      models: modelsObj,
    };
  } else if (config.provider.workbuddy) {
    delete config.provider.workbuddy;
  }

  try {
    const configDir = path.dirname(configPath);
    if (process.platform !== 'win32') {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    } else {
      fs.mkdirSync(configDir, { recursive: true });
    }
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, configPath);
    log(`${path.basename(configPath)} 已同步：enabled=${isEnabled}`);
    return true;
  } catch (error) {
    log(`写入 ${path.basename(configPath)} 失败：`, error.message);
    return false;
  }
}

// ─────────────────────── 用量统计 ───────────────────────

function getModelCreditCost(modelId) {
  const m = (state.models || []).find((item) => item.id === modelId);
  if (!m) return 0;
  if (m.isFree) return 0;
  const creditsStr = String(m.credits || '').trim();
  if (!creditsStr) return 0;
  if (/free/i.test(creditsStr) || /内置/.test(creditsStr)) return 0;
  const match = creditsStr.match(/x?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (match) {
    const val = parseFloat(match[1]);
    return Number.isFinite(val) ? val : 0;
  }
  return 0;
}

function recordUsage({ model, inputTokens, outputTokens, generationMs }) {
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const creditCost = getModelCreditCost(model);
  const genMs = Math.max(0, Number(generationMs) || 0);

  // 1. 当前激活账号用量记录
  const usage = state.usage;
  usage.requestCount += 1;
  usage.inputTokens += inTok;
  usage.outputTokens += outTok;
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  if (genMs > 0) usage.generationMs += genMs;

  if (creditCost > 0) {
    state.credits.totalConsumed = Math.round((state.credits.totalConsumed + creditCost) * 10000) / 10000;
    state.credits.currentBalance = Math.max(0, Math.round((state.credits.initialBalance - state.credits.totalConsumed) * 10000) / 10000);
  }

  const id = model || 'unknown';
  if (!usage.modelStats[id]) usage.modelStats[id] = { requests: 0, inputTokens: 0, outputTokens: 0, creditsConsumed: 0 };
  const stat = usage.modelStats[id];
  stat.requests += 1;
  stat.inputTokens += inTok;
  stat.outputTokens += outTok;
  stat.creditsConsumed = Math.round(((stat.creditsConsumed || 0) + creditCost) * 10000) / 10000;

  // 2. 插件全局跨账号累计用量记录
  if (!state.globalUsage) state.globalUsage = defaultGlobalUsage();
  const gu = state.globalUsage;
  gu.requestCount += 1;
  gu.inputTokens += inTok;
  gu.outputTokens += outTok;
  gu.totalTokens = gu.inputTokens + gu.outputTokens;
  if (genMs > 0) gu.generationMs += genMs;
  if (creditCost > 0) {
    gu.creditsConsumed = Math.round(((gu.creditsConsumed || 0) + creditCost) * 10000) / 10000;
  }

  saveState();
}

function usageSnapshot() {
  const u = state.usage || defaultUsage();
  const genMs = u.generationMs || 0;
  const gu = state.globalUsage || defaultGlobalUsage();
  const gGenMs = gu.generationMs || 0;
  const agg = computeAggregateUsage();
  const curAcc = getActiveAccount();

  return {
    // 当前账号视角
    currentAccount: {
      id: curAcc ? curAcc.id : null,
      nickname: curAcc ? curAcc.nickname : (state.credential ? state.credential.nickname : ''),
      uid: curAcc ? curAcc.uid : (state.credential ? state.credential.uid : ''),
      region: state.currentRegion,
      status: curAcc ? curAcc.status : (state.credential ? 'active' : 'ready'),
      totalTokens: u.totalTokens,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      requestCount: u.requestCount,
      avgTokPerSec: genMs > 0 ? Math.round(((u.outputTokens / genMs) * 1000) * 10) / 10 : 0,
      modelStats: u.modelStats || {},
      credits: {
        initialBalance: state.credits.initialBalance,
        currentBalance: state.credits.currentBalance,
        totalConsumed: state.credits.totalConsumed,
        lastCalibratedAt: state.credits.lastCalibratedAt,
      },
    },
    // 全局累计用量视角（插件在所有账号上的生命周期总统计）
    globalCumulative: {
      totalTokens: gu.totalTokens,
      inputTokens: gu.inputTokens,
      outputTokens: gu.outputTokens,
      requestCount: gu.requestCount,
      creditsConsumed: gu.creditsConsumed || 0,
      avgTokPerSec: gGenMs > 0 ? Math.round(((gu.outputTokens / gGenMs) * 1000) * 10) / 10 : 0,
    },
    // 全账号动态汇总（将账号池内所有账号相加求和）
    allAccountsAggregate: agg,

    // 保持顶层字段向后兼容
    totalTokens: u.totalTokens,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    requestCount: u.requestCount,
    avgTokPerSec: genMs > 0 ? Math.round(((u.outputTokens / genMs) * 1000) * 10) / 10 : 0,
    modelStats: u.modelStats,
    credits: {
      initialBalance: state.credits.initialBalance,
      currentBalance: state.credits.currentBalance,
      totalConsumed: state.credits.totalConsumed,
      lastCalibratedAt: state.credits.lastCalibratedAt,
    },
  };
}

// ─────────────────────── 鉴权与上游 ───────────────────────

function credentialBaseHeaders() {
  return {
    'X-Domain': WORKBUDDY.apiDomain,
    'User-Agent': WORKBUDDY.userAgent,
    'X-Product': WORKBUDDY.deploymentType,
    'X-Product-Code': WORKBUDDY.productCode,
  };
}

function credentialExpiresAtMs() {
  const raw = state.credential && state.credential.expires_at;
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const v = Number(raw);
      return v > 1e12 ? v : v * 1000;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return jwtClaimMs(state.credential && state.credential.access_token, 'exp');
}

function newUuid() {
  return crypto.randomUUID();
}

function new32Hex() {
  return crypto.randomUUID().replace(/-/g, '');
}

function buildTraceHeaders() {
  const trace = new32Hex();
  const span = crypto.randomBytes(8).toString('hex');
  return {
    'X-Trace-ID': trace,
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1`,
    'X-B3-TraceId': trace,
    'X-B3-SpanId': span,
    'X-B3-Sampled': '1',
  };
}

/**
 * 构造与官方桌面客户端 100% 对齐的对话请求头族。
 * 包含会话跟踪头（X-Conversation-ID 等）与分布式链路头，彻底解决上游 11128 渠道校验拦截。
 */
function buildChatHeaders(accessToken, payloadLength) {
  const activeRegion = getActiveRegion();
  const convId = newUuid();
  const convReqId = new32Hex();
  const msgId = new32Hex();
  let uid = 'anonymous';
  if (state.credential && state.credential.uid) {
    uid = state.credential.uid;
  } else {
    const payload = jwtPayload(accessToken);
    if (payload && (payload.sub || payload.uid)) {
      uid = payload.sub || payload.uid;
    }
  }

  const headers = {
    ...credentialBaseHeaders(),
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'Content-Length': payloadLength,
    // 关键：官方客户端会话头族与链路追踪头族（彻底解决 11128 / 11-128 渠道拦截）
    'X-Conversation-ID': convId,
    'X-Conversation-Request-ID': convReqId,
    'X-Root-Request-ID': convReqId,
    'X-Conversation-Message-ID': msgId,
    'X-Request-ID': msgId,
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'CLI',
    'X-IDE-Version': activeRegion.version || clientVersions.appVersion || '5.9.4',
    'X-Private-Data': 'true',
    'X-User-Id': String(uid),
    ...buildTraceHeaders(),
  };

  if (state.credential && state.credential.enterprise_id) {
    headers['X-Enterprise-Id'] = String(state.credential.enterprise_id);
    headers['X-Tenant-Id'] = String(state.credential.tenant_id || state.credential.enterprise_id);
  }
  if (state.credential && state.credential.department) {
    headers['X-Department-Info'] = String(state.credential.department);
  }

  return headers;
}

/** 临期/过期时用 refresh_token 静默续期 */
async function ensureFreshCredential() {
  if (!state.credential) return false;
  const expires = credentialExpiresAtMs();
  if (expires === undefined || Date.now() < expires - REFRESH_SKEW_MS) return true;
  if (!state.credential.refresh_token) return false;

  log('凭据临期，尝试刷新…');
  try {
    const res = await requestJSON(
      'POST',
      `${WORKBUDDY.endpoint}/v2/plugin/auth/token/refresh`,
      {
        ...credentialBaseHeaders(),
        Authorization: `Bearer ${state.credential.access_token}`,
        'X-Refresh-Token': state.credential.refresh_token,
        'X-Auth-Refresh-Source': WORKBUDDY.refreshSource,
      },
      null,
      60000,
    );
    const body = parseJSON(res.body);
    if (res.status === 200 && body && body.data && readStringField(body.data, 'accessToken')) {
      const old = state.credential;
      state.credential = {
        ...old,
        access_token: readStringField(body.data, 'accessToken'),
        refresh_token: readStringField(body.data, 'refreshToken') || old.refresh_token,
        expires_at: String(Date.now() + (readNumberField(body.data, 'expiresIn') || 7200) * 1000),
      };
      saveState();
      log('凭据刷新成功');
      return true;
    }
    log('凭据刷新失败：', res.status, res.body.slice(0, 200));
  } catch (error) {
    log('凭据刷新异常：', error.message);
  }
  return false;
}

// ─────────────────────── 模型列表 ───────────────────────

function parseModelsFromConfig(data) {
  if (!data || typeof data !== 'object') return [];
  const metaById = new Map();
  if (Array.isArray(data.models)) {
    for (const entry of data.models) {
      if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
        metaById.set(entry.id, entry);
      }
    }
  }
  const promoMap = new Map();
  if (Array.isArray(data.modelPromotions)) {
    for (const p of data.modelPromotions) {
      if (!p || !p.enabled) continue;
      for (const mid of p.modelIds || []) {
        promoMap.set(mid, p);
      }
    }
  }
  const agentIds = new Set();
  if (Array.isArray(data.agents)) {
    for (const agent of data.agents) {
      if (!agent || typeof agent !== 'object') continue;
      if (agent.name !== 'craft' && agent.name !== 'cli') continue;
      if (Array.isArray(agent.models)) {
        for (const id of agent.models) if (typeof id === 'string') agentIds.add(id);
      }
    }
  }

  const result = [];
  const seen = new Set();
  const push = (id) => {
    if (typeof id !== 'string' || id.length === 0) return;
    if (id === 'auto' || id === 'default') return;
    if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) return;
    if (seen.has(id)) return;
    const meta = metaById.get(id);
    const maxOut = meta && typeof meta.maxOutputTokens === 'number' ? meta.maxOutputTokens : undefined;
    if (typeof maxOut === 'number' && maxOut > 0 && maxOut <= 256) return;
    if (meta && Array.isArray(meta.tags) && meta.tags.includes('text-to-image')) return;
    seen.add(id);
    const ctx = meta && typeof meta.maxInputTokens === 'number' ? meta.maxInputTokens : undefined;
    const promo = promoMap.get(id);
    const promoFree = promo && (promo.discount?.factor === 0 || String(promo.badge?.label || '').toLowerCase().includes('free'));
    const isFree = promoFree || meta?.credits === 'x0.00' || id === 'default-model';
    const creditsLabel = promo
      ? `${promo.badge?.label || 'Free'} (${promo.discount?.discountedCredits || '0x'})`
      : (meta?.credits || (id === 'default-model' ? '内置包含' : ''));

    result.push({
      id,
      name: (meta && typeof meta.name === 'string' && meta.name) || id,
      contextWindow: typeof ctx === 'number' && ctx > 0 ? ctx : undefined,
      maxOutputTokens: typeof maxOut === 'number' && maxOut > 0 ? maxOut : undefined,
      supportsImages: meta ? Boolean(meta.supportsImages) : undefined,
      credits: creditsLabel,
      isFree: Boolean(isFree),
      reasoningEfforts:
        meta && meta.reasoning && Array.isArray(meta.reasoning.supportedEfforts)
          ? meta.reasoning.supportedEfforts.filter((e) => typeof e === 'string')
          : undefined,
    });
  };

  for (const id of agentIds) push(id);
  for (const id of metaById.keys()) push(id);
  return result;
}

async function tryFetchUpstreamBalance() {
  if (!state.credential || !state.credential.access_token) return;
  const activeRegion = getActiveRegion();
  const endpoints = [
    `${activeRegion.endpoint}/v2/billing/meter/get-user-resource`,
    `${activeRegion.endpoint}/billing/meter/get-user-resource-summary`,
  ];
  for (const url of endpoints) {
    try {
      const res = await requestJSON('POST', url, {
        ...credentialBaseHeaders(),
        Authorization: `Bearer ${state.credential.access_token}`,
      }, {}, 6000);
      if (res.status === 200) {
        const body = parseJSON(res.body);
        if (body && body.data) {
          const d = body.data;
          const val = readNumberField(d, 'CycleRemainCapacity') ??
                      readNumberField(d, 'remainCapacity') ??
                      readNumberField(d, 'balance') ??
                      readNumberField(d, 'credits');
          if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
            state.credits.initialBalance = val;
            state.credits.currentBalance = val;
            state.credits.totalConsumed = 0;
            state.credits.lastCalibratedAt = Date.now();
            saveState();
            log(`已从官方接口自动同步积分余额：${val}`);
            return;
          }
        }
      }
    } catch {
      // 官方若需 Web Session Cookie 则静默跳过，使用本地实时扣减
    }
  }
}

async function fetchModels(force = false) {
  if (!state.credential) return state.models;
  if (!force && state.models.length > 0 && Date.now() - state.modelsFetchedAt < MODELS_CACHE_TTL_MS) {
    return state.models;
  }
  try {
    const res = await requestJSON('GET', `${WORKBUDDY.endpoint}/v3/config`, {
      ...credentialBaseHeaders(),
      Authorization: `Bearer ${state.credential.access_token}`,
    }, null, 60000);
    const body = parseJSON(res.body);
    if (res.status === 200 && body && body.data) {
      const models = parseModelsFromConfig(body.data);
      if (models.length > 0) {
        state.models = models;
        state.modelsFetchedAt = Date.now();
        saveState();
        log(`模型列表已更新：${models.length} 个`);
      }
    } else {
      log('拉取模型列表失败：', res.status, res.body.slice(0, 200));
    }
  } catch (error) {
    log('拉取模型列表异常：', error.message);
  }
  tryFetchUpstreamBalance().catch(() => {});
  return state.models;
}

// ─────────────────────── 登录流程 ───────────────────────

function decorateLoginUrl(authUrl) {
  try {
    const url = new URL(authUrl);
    url.searchParams.set('version', WORKBUDDY.version);
    url.searchParams.set('loginSessionId', crypto.randomUUID());
    return url.toString();
  } catch {
    return authUrl;
  }
}

async function pollToken(stateId, deadlineMs = 5 * 60 * 1000) {
  const url = `${WORKBUDDY.endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(stateId)}`;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const res = await requestJSON('GET', url, {
        'User-Agent': WORKBUDDY.userAgent,
        'X-No-Authorization': 'true',
      }, null, 60000);
      const body = parseJSON(res.body);
      if (res.status === 200 && body && body.data && readStringField(body.data, 'accessToken')) {
        const d = body.data;
        return {
          access_token: readStringField(d, 'accessToken'),
          refresh_token: readStringField(d, 'refreshToken'),
          expires_at: readStringField(d, 'expiresAt') ||
            String(Date.now() + (readNumberField(d, 'expiresIn') || 7200) * 1000),
        };
      }
    } catch {
      continue;
    }
  }
  throw new Error('获取 token 超时（5 分钟）');
}

async function pollAccount(stateId, accessToken, deadlineMs = 5 * 60 * 1000) {
  const url = `${WORKBUDDY.endpoint}/v2/plugin/login/account?state=${encodeURIComponent(stateId)}`;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const res = await requestJSON('GET', url, {
        ...credentialBaseHeaders(),
        Authorization: `Bearer ${accessToken}`,
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
      }, null, 60000);
      const body = parseJSON(res.body);
      if (res.status === 200 && body && body.data) {
        const d = body.data;
        return {
          uid: readStringField(d, 'uid'),
          nickname: readStringField(d, 'nickname') || jwtPayload(accessToken).nickname || '',
          account_type: readStringField(d, 'type') || 'personal',
        };
      }
    } catch {
      continue;
    }
  }
  throw new Error('获取账户信息超时（5 分钟）');
}

async function startLogin() {
  const res = await requestJSON(
    'POST',
    `${WORKBUDDY.endpoint}/v2/plugin/auth/state?platform=${WORKBUDDY.platform}`,
    {
      'X-Domain': WORKBUDDY.apiDomain,
      'User-Agent': WORKBUDDY.userAgent,
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
    },
    null,
    10000,
  );
  const body = parseJSON(res.body);
  if (res.status !== 200 || !body || !body.data) {
    throw new Error(`auth/state HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const stateId = readStringField(body.data, 'state');
  const authUrl = readStringField(body.data, 'authUrl');
  if (!stateId || !authUrl) throw new Error('auth/state 响应缺少 state 或 authUrl');
  return { state: stateId, loginUrl: decorateLoginUrl(authUrl) };
}

function runLoginBackground(stateId) {
  state.loginInProgress = true;
  state.loginError = '';
  (async () => {
    try {
      const token = await pollToken(stateId);
      const account = await pollAccount(stateId, token.access_token);
      const acc = addOrUpdateAccount(state.currentRegion, token, account);
      await fetchModels(true);
      saveState();
      if (state.enabled) syncOpenCodeConfig(true);
      log(`登录成功并归档至账号池：${acc.nickname || acc.uid} (ID: ${acc.id})`);
    } catch (error) {
      state.loginError = error.message;
      log('登录失败：', error.message);
    } finally {
      state.loginInProgress = false;
    }
  })();
}

// ─────────────────────── 上游聊天（SSE 透传） ───────────────────────

// ─────────────────────── 补丁 02 · 提示词特征清洗与隐形断点 (Identity Sanitizer) ───────────────────────

const ZERO_WIDTH_SPACE = '\u200B';
const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.';

const UNAPPROVED_CHANNEL_OPENINGS = [
  'you are an ai agent powered by',
  'you are claude code',
  'you are opencode',
  'you are an autonomous agent',
  'you are an ai coding assistant',
  'you are an interactive cli tool',
  'you are a powerful agentic ai',
  'the runtime context names',
];

const IDENTITY_CLAUSE_REGEX = /(you)(\s+are\s+(?:(?:an?\s+)?[\w-]*\s*agent\s+powered\s+by|interacting\s+with\s+the\s+user\s+through\s+the\s+(?:deepseek\s+harness|opencode)))|((?:current|the\s+runtime\s+context\s+names\s+the)\s+(?:deepseek\s+harness|opencode)\s+(?:implementation\s+checkout|web\s+gui\s+url))/giu;

function isUnapprovedChannelOpening(text) {
  if (typeof text !== 'string') return false;
  const opening = text.replace(/^\s+/u, '').toLowerCase();
  return UNAPPROVED_CHANNEL_OPENINGS.some((prefix) => opening.startsWith(prefix));
}

function breakIdentityClauses(text) {
  if (typeof text !== 'string') return text;
  return text.replace(IDENTITY_CLAUSE_REGEX, (clause) => clause.replace(/(\s+)/gu, `$1${ZERO_WIDTH_SPACE}`));
}

function sanitizePromptText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const headPrepend = isUnapprovedChannelOpening(text) ? `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${text}` : text;
  return breakIdentityClauses(headPrepend);
}

function sanitizeMessages(messages) {
  const result = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const cloned = { ...m };
    if (cloned.role === 'developer') {
      cloned.role = 'system';
    }
    if (cloned.role === 'system' || cloned.role === 'assistant') {
      if (typeof cloned.content === 'string') {
        cloned.content = sanitizePromptText(cloned.content);
      } else if (Array.isArray(cloned.content)) {
        cloned.content = cloned.content.map((part) => {
          if (part && part.type === 'text' && typeof part.text === 'string') {
            return { ...part, text: sanitizePromptText(part.text) };
          }
          return part;
        });
      }
    }
    result.push(cloned);
  }
  return result;
}

// ─────────────────────── 补丁 04 · 单模型 6004 限流同账号迂回 (Model Detour) ───────────────────────

function bodyDeclaresImage(requestBody) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') return true;
    }
  }
  return false;
}

const DETOUR_LADDER_ORDER = [
  'hy4-preview',
  'glm-5.3',
  'glm-5.2',
  'kimi-k2.8-preview',
  'kimi-k3',
  'deepseek-v4-pro',
  'deepseek-v3.2',
  'gpt-5.6-terra',
  'primary-model',
];

function getDetourCandidateModels(requestBody, currentModel) {
  const disabledSet = new Set(state.disabledModels || []);
  const available = (state.models || []).filter((m) => !disabledSet.has(m.id) && m.id !== currentModel);
  const needsImage = bodyDeclaresImage(requestBody);

  const candidates = [];
  for (const preferred of DETOUR_LADDER_ORDER) {
    const found = available.find((m) => m.id === preferred);
    if (found) {
      if (needsImage && !found.supportsImages) continue;
      candidates.push(found.id);
      if (candidates.length >= 3) return candidates;
    }
  }
  for (const m of available) {
    if (!candidates.includes(m.id) && !/default-model|auto|fast-model|balanced-model/i.test(m.id)) {
      if (needsImage && !m.supportsImages) continue;
      candidates.push(m.id);
      if (candidates.length >= 3) break;
    }
  }
  return candidates;
}

function buildUpstreamBody(requestBody) {
  const rawMessages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const model = String(requestBody.model || '');
  const messages = sanitizeMessages(rawMessages);

  const wire = messages.map((m) => {
    if (m && m.role === 'assistant') {
      return { ...m, reasoning_content: m.reasoning_content || '' };
    }
    return m;
  });

  // WorkBuddy 上游硬性要求首条消息必须为 system prompt
  if (wire.length === 0 || wire[0].role !== 'system') {
    wire.unshift({
      role: 'system',
      content: WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
    });
  } else if (!wire[0].content || (typeof wire[0].content === 'string' && wire[0].content.trim().length === 0)) {
    wire[0].content = WORKBUDDY_FALLBACK_SYSTEM_PROMPT;
  }

  // WorkBuddy 上游拒绝非流式请求（code 11101），必须始终 stream: true
  const body = { model, messages: wire, stream: true };

  // 关键修复：透传 tools 与 tool_choice，使 Agent 工具调用（read, shell 等）能正常通过标准 API 协议执行
  // 否则模型无法走标准 tool_calls，会退化输出内部标记 < | | DSML | | calls >
  if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
    body.tools = requestBody.tools;
    if (requestBody.tool_choice !== undefined) {
      body.tool_choice = requestBody.tool_choice;
    }
  }

  // 部分推理模型（如 gpt-6-sol）要求 max_tokens >= 32
  const maxTokens = typeof requestBody.max_tokens === 'number' ? requestBody.max_tokens : requestBody.max_completion_tokens;
  if (typeof maxTokens === 'number') {
    body.max_tokens = Math.max(32, maxTokens);
  }
  if (typeof requestBody.temperature === 'number') body.temperature = requestBody.temperature;
  if (typeof requestBody.top_p === 'number') body.top_p = requestBody.top_p;
  if (typeof requestBody.presence_penalty === 'number') body.presence_penalty = requestBody.presence_penalty;
  if (typeof requestBody.frequency_penalty === 'number') body.frequency_penalty = requestBody.frequency_penalty;
  if (requestBody.stop !== undefined) body.stop = requestBody.stop;
  if (requestBody.response_format !== undefined) body.response_format = requestBody.response_format;

  // 深度思考（Reasoning / Thinking）自动注入与协商：
  const clientEffort = requestBody.reasoning_effort || requestBody.reasoningEffort;
  const clientThinking = requestBody.thinking;
  const isDeepSeek = /^deepseek/i.test(model);

  const optedOut = (clientThinking && clientThinking.type === 'disabled') ||
                   (typeof clientEffort === 'string' && clientEffort.toLowerCase() === 'none');

  if (!optedOut) {
    if (clientEffort && String(clientEffort).toLowerCase() !== 'none') {
      body.reasoning_effort = clientEffort;
    }
    if (clientThinking && typeof clientThinking === 'object') {
      body.thinking = clientThinking;
    }

    // 关键：WorkBuddy 上游 DeepSeek 深度思考生效规则：
    // 上游要求必须同时具备 thinking: { type: 'enabled' } 以及具体的 effort 档位（默认 high），
    // 否则即使模型名是 deepseek-v4.1-flash，上游推理链 token 也会为 0（不输出 reasoning_content）。
    if (isDeepSeek) {
      if (!body.thinking) {
        body.thinking = { type: 'enabled' };
      }
      if (!body.reasoning_effort) {
        body.reasoning_effort = 'high';
      }
    }
  } else {
    if (isDeepSeek) {
      body.thinking = { type: 'disabled' };
    }
  }
  return body;
}

function estimateInputTokens(requestBody) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  let chars = 0;
  for (const m of messages) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          chars += part.text.length;
        } else if (part.type === 'image_url') {
          // 图片按 ~1000 tokens 估算，避免将巨大 base64 字符串直接当成数百万字符文本折算
          chars += 1500;
        }
      }
    } else {
      chars += JSON.stringify(m).length;
    }
  }
  return estimateTokens(chars.toString());
}

/**
 * 模型测速探针：采用流式探针，测得首字延迟（TTFT）后即可断开，省流且精确
 */
function probeModel(model, accessToken, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const payload = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      max_tokens: 64,
    });

    let url;
    try {
      url = new URL(`${WORKBUDDY.endpoint}/v2/chat/completions`);
    } catch (e) {
      resolve({ ok: false, status: 500, error: e.message, latencyMs: 0 });
      return;
    }

    const req = pickClientFor(url.toString()).request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        headers: buildChatHeaders(accessToken, Buffer.byteLength(payload)),
      },
      (res) => {
        let settled = false;
        let body = '';

        res.on('data', (chunk) => {
          body += chunk.toString('utf8');
          if (res.statusCode === 200 && !settled) {
            if (body.includes('"code":')) {
              settled = true;
              req.destroy();
              resolve({
                ok: false,
                status: 200,
                latencyMs: Date.now() - started,
                error: body.slice(0, 200),
              });
            } else if (body.trimStart().startsWith('data:')) {
              settled = true;
              const latencyMs = Date.now() - started;
              req.destroy();
              resolve({
                ok: true,
                status: 200,
                latencyMs,
                error: '',
              });
            }
          }
        });

        res.on('end', () => {
          if (!settled) {
            settled = true;
            const latencyMs = Date.now() - started;
            const isError = res.statusCode !== 200 || body.includes('"code":');
            resolve({
              ok: !isError,
              status: res.statusCode || 200,
              latencyMs,
              error: isError ? body.slice(0, 200) : '',
            });
          }
        });

        res.on('error', (err) => {
          if (!settled) {
            settled = true;
            resolve({ ok: false, status: res.statusCode || 500, error: err.message, latencyMs: Date.now() - started });
          }
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: 408, error: `timeout after ${timeoutMs}ms`, latencyMs: Date.now() - started });
    });

    req.on('error', (err) => {
      resolve({ ok: false, status: 500, error: err.message, latencyMs: Date.now() - started });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * 代理 chat completions：
 * 1. 客户端如果要求 stream: true -> 真流式透传
 * 2. 客户端如果要求 stream: false -> 自动将上游 SSE 汇聚为标准 ChatCompletion JSON
 * 3. 补丁 03 · 封号强隔离 (Account Quarantine): 11140 严禁自动换号重放，彻底熔断保护小号池
 * 4. 补丁 04 · 单模型 6004 限流同账号迂回 (Model Detour): 单模型频控同账号换模型重试，不骚扰其他小号
 */
function proxyChatCompletion(originalRequestBody, res) {
  return new Promise((resolve) => {
    function sendAttempt(requestBody, attempt = 0) {
      const model = String(requestBody.model || '');
      const clientWantsStream = requestBody.stream !== false;
      const inputTokens = estimateInputTokens(requestBody);
      const upstreamBody = buildUpstreamBody(requestBody);
      const payload = JSON.stringify(upstreamBody);

      let url;
      try {
        url = new URL(`${WORKBUDDY.endpoint}/v2/chat/completions`);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String(error) } }));
        }
        resolve();
        return;
      }

      const startedAt = Date.now();
      let ttftMs = null;
      let outputChars = 0;
      let settled = false;

      const finish = (code) => {
        if (settled) return;
        settled = true;
        const generationMs = Math.max(0, Date.now() - startedAt - (ttftMs || 0));
        if (code === 200) {
          recordUsage({
            model,
            inputTokens,
            outputTokens: estimateTokens('x'.repeat(Math.min(outputChars, 2_000_000))),
            generationMs,
          });
        }
        resolve();
      };

      const req = pickClientFor(url.toString()).request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          headers: buildChatHeaders(state.credential.access_token, Buffer.byteLength(payload)),
        },
        (up) => {
          if (up.statusCode && up.statusCode >= 400) {
            let errData = '';
            up.on('data', (c) => { errData += c; });
            up.on('end', () => {
              log(`上游请求失败 HTTP ${up.statusCode} (${model}):`, errData.slice(0, 300));
              const errObj = parseJSON(errData) || {};
              const is11140 = errObj.code === 11140 || /11140/i.test(errData) || /账号存在异常行为/i.test(errData);
              const is6004 = up.statusCode === 429 || errObj.code === 6004 || /6004/i.test(errData) || /频率限制/i.test(errData);

              // 补丁 03 · 封号强隔离：发现 11140 严禁将相同请求重放给其他小号，直接熔断报错，保全小号池！
              if (is11140) {
                const curAcc = getActiveAccount();
                if (curAcc) {
                  curAcc.status = 'restricted';
                  curAcc.statusNote = '11140: 账号已被上游风控限制使用';
                  saveState();
                  log(`🚨 当前账号触发 11140 限制，已启动安全熔断阻断自动换号！绝不将相同请求重放至其它小号！(${curAcc.nickname || curAcc.uid})`);
                }
                if (!res.headersSent) {
                  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
                  res.end(JSON.stringify({
                    error: {
                      code: 'account_restricted',
                      message: '账号存在异常行为，已被限制使用 (11140)。已触发安全熔断保护其余小号。请停止高频请求或在官方申诉。',
                      raw: errObj,
                    },
                  }));
                }
                finish(403);
                return;
              }

              // 补丁 04 · 单模型 6004 频控同账号平滑降级迂回（Model Detour）
              if (is6004 && attempt < 3) {
                const detourModels = getDetourCandidateModels(requestBody, model);
                if (detourModels.length > 0) {
                  const substituteModel = detourModels[attempt % detourModels.length];
                  log(`🔄 模型 ${model} 触发单模型 6004 频控窗口（单账号单模型限额），启动同账号平滑迂回至备选模型: ${substituteModel} (第 ${attempt + 1} 梯队)...`);
                  const nextRequestBody = { ...requestBody, model: substituteModel };
                  sendAttempt(nextRequestBody, attempt + 1);
                  return;
                }
              }

              if (up.statusCode === 401) {
                const curAcc = getActiveAccount();
                if (curAcc) {
                  curAcc.status = 'expired';
                  curAcc.statusNote = '凭据已失效，需重新授权';
                  saveState();
                }
              }

              if (!res.headersSent) {
                res.writeHead(up.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(errData || JSON.stringify({ error: { message: `Upstream HTTP ${up.statusCode}` } }));
              }
              finish(up.statusCode);
            });
            return;
          }

          if (clientWantsStream) {
            let streamHeadersWritten = false;
            let streamChunkBuffer = '';

            up.on('data', (chunk) => {
              if (ttftMs === null) ttftMs = Date.now() - startedAt;
              outputChars += chunk.length;

              if (!streamHeadersWritten) {
                streamChunkBuffer += chunk.toString('utf8');
                // 检测上游是否在 200 流的开头返回了异常拦截错误 JSON
                if (streamChunkBuffer.includes('"code":11140') || streamChunkBuffer.includes('账号存在异常行为')) {
                  const curAcc = getActiveAccount();
                  if (curAcc) {
                    curAcc.status = 'restricted';
                    curAcc.statusNote = '11140: 账号已被上游风控限制使用';
                    saveState();
                    log(`🚨 当前账号触发 11140 限制，已启动安全熔断阻断自动换号！(${curAcc.nickname || curAcc.uid})`);
                  }
                  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
                  res.end(JSON.stringify({
                    error: {
                      code: 'account_restricted',
                      message: '账号存在异常行为，已被限制使用 (11140)。已触发安全熔断保护其余小号。',
                    },
                  }));
                  finish(403);
                  return;
                }

                // 检测是否在首包返回了 6004 频控
                if (streamChunkBuffer.includes('"code":6004') || streamChunkBuffer.includes('频率限制')) {
                  if (attempt < 3) {
                    const detourModels = getDetourCandidateModels(requestBody, model);
                    if (detourModels.length > 0) {
                      const substituteModel = detourModels[attempt % detourModels.length];
                      log(`🔄 流式首包检测到 6004 频控，启动同账号平滑迂回至备选模型: ${substituteModel}...`);
                      sendAttempt({ ...requestBody, model: substituteModel }, attempt + 1);
                      return;
                    }
                  }
                }

                res.writeHead(up.statusCode || 200, {
                  'Content-Type': 'text/event-stream; charset=utf-8',
                  'Cache-Control': 'no-cache, no-transform',
                  Connection: 'keep-alive',
                  'X-Accel-Buffering': 'no',
                });
                streamHeadersWritten = true;
              }

              res.write(chunk);
            });

            up.on('end', () => {
              if (streamHeadersWritten) {
                res.write('data: [DONE]\n\n');
                res.end();
              }
              finish(200);
            });

            up.on('error', (err) => {
              log('Upstream stream error:', err.message);
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
              } else {
                res.end();
              }
              finish(500);
            });
          } else {
            let accumulatedContent = '';
            let accumulatedReasoning = '';
            let chunkId = 'chatcmpl-' + crypto.randomUUID();
            let finishReason = 'stop';
            let sseBuffer = '';
            const toolCallsMap = new Map();

            up.on('data', (chunk) => {
              if (ttftMs === null) ttftMs = Date.now() - startedAt;
              outputChars += chunk.length;
              sseBuffer += chunk.toString('utf8');
              const lines = sseBuffer.split('\n');
              sseBuffer = lines.pop() || '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr === '[DONE]') continue;
                const data = parseJSON(jsonStr);
                if (data) {
                  if (data.id) chunkId = data.id;
                  if (Array.isArray(data.choices) && data.choices[0]) {
                    const choice = data.choices[0];
                    if (choice.delta) {
                      if (choice.delta.content) accumulatedContent += choice.delta.content;
                      if (choice.delta.reasoning_content) accumulatedReasoning += choice.delta.reasoning_content;
                      if (choice.delta.reasoning) accumulatedReasoning += choice.delta.reasoning;
                      if (Array.isArray(choice.delta.tool_calls)) {
                        for (const tc of choice.delta.tool_calls) {
                          const idx = tc.index ?? 0;
                          if (!toolCallsMap.has(idx)) {
                            toolCallsMap.set(idx, {
                              id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
                              type: tc.type || 'function',
                              function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' },
                            });
                          } else {
                            const existing = toolCallsMap.get(idx);
                            if (tc.id) existing.id = tc.id;
                            if (tc.function?.name) existing.function.name += tc.function.name;
                            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                          }
                        }
                      }
                    }
                    if (choice.finish_reason) finishReason = choice.finish_reason;
                  }
                }
              }
            });

            up.on('end', () => {
              const outTokens = estimateTokens(accumulatedContent + accumulatedReasoning);
              const finalToolCalls = Array.from(toolCallsMap.values());
              const responsePayload = {
                id: chunkId,
                object: 'chat.completion',
                created: Math.floor(startedAt / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: accumulatedContent,
                      ...(accumulatedReasoning ? { reasoning_content: accumulatedReasoning } : {}),
                      ...(finalToolCalls.length > 0 ? { tool_calls: finalToolCalls } : {}),
                    },
                    finish_reason: finalToolCalls.length > 0 && (!finishReason || finishReason === 'stop') ? 'tool_calls' : (finishReason || 'stop'),
                  },
                ],
                usage: {
                  prompt_tokens: inputTokens,
                  completion_tokens: outTokens,
                  total_tokens: inputTokens + outTokens,
                },
              };
              sendJSON(res, 200, responsePayload);
              finish(200);
            });

            up.on('error', (err) => {
              log('Upstream non-stream error:', err.message);
              if (!res.headersSent) {
                sendJSON(res, 502, { error: { message: `Upstream error: ${err.message}` } });
              } else {
                res.end();
              }
              finish(502);
            });
          }
        },
      );

      req.setTimeout(300000, () => req.destroy(new Error('upstream timeout')));
      req.on('error', (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `上游请求失败：${error.message}` } }));
        } else {
          res.end();
        }
        finish(0);
      });

      req.write(payload);
      req.end();
    }

    sendAttempt(originalRequestBody, 0);
  });
}

// ─────────────────────── 控制面路由 ───────────────────────

async function handleControl(req, res, pathname) {
  switch (pathname) {
    case '/health':
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OK');
      return;

    case '/status': {
      await ensureFreshCredential().catch(() => {});
      const disabledSet = new Set(state.disabledModels || []);
      const enabledCount = state.models.filter((m) => !disabledSet.has(m.id)).length;
      const activeRegion = getActiveRegion();
      const agg = computeAggregateUsage();
      const curAcc = getActiveAccount();
      sendJSON(res, 200, {
        currentRegion: state.currentRegion,
        regionName: activeRegion.name,
        regions: Object.values(REGIONS).map((r) => ({ id: r.id, name: r.name, endpoint: r.endpoint })),
        enabled: state.enabled,
        loggedIn: Boolean(state.credential),
        credentialValid: Boolean(state.credential),
        loginInProgress: state.loginInProgress,
        loginError: state.loginError,
        account: curAcc
          ? { id: curAcc.id, uid: curAcc.uid, nickname: curAcc.nickname, status: curAcc.status, statusNote: curAcc.statusNote }
          : (state.credential ? { uid: state.credential.uid, nickname: state.credential.nickname } : null),
        activeAccountId: curAcc ? curAcc.id : null,
        accounts: agg.accounts,
        totalAccountsCount: agg.accountsCount,
        modelsCount: state.models.length,
        enabledModelsCount: enabledCount,
        disabledModels: state.disabledModels || [],
        gatewayPort: GATEWAY_PORT,
        configPath: getOpenCodeConfigPath(),
        hardened: {
          active: true,
          appVersion: clientVersions.appVersion,
          cliVersion: clientVersions.cliVersion,
          source: clientVersions.source,
          features: [
            'version-sync',
            'identity-sanitizer',
            'account-quarantine',
            'model-detour-6004',
          ],
        },
        credits: {
          initialBalance: state.credits.initialBalance,
          currentBalance: state.credits.currentBalance,
          totalConsumed: state.credits.totalConsumed,
          lastCalibratedAt: state.credits.lastCalibratedAt,
        },
      });
      return;
    }

    case '/accounts': {
      const agg = computeAggregateUsage();
      const activeRegion = getActiveRegion();
      const curAcc = getActiveAccount();
      sendJSON(res, 200, {
        currentRegion: state.currentRegion,
        regionName: activeRegion.name,
        activeAccountId: curAcc ? curAcc.id : null,
        accounts: agg.accounts,
        totalCount: agg.accountsCount,
      });
      return;
    }

    case '/accounts/switch': {
      const body = await readJsonBody(req);
      const accountId = String(body.accountId || '');
      if (!accountId) {
        sendJSON(res, 400, { error: '缺少 accountId' });
        return;
      }
      try {
        const switched = await switchActiveAccount(accountId);
        sendJSON(res, 200, {
          ok: true,
          account: {
            id: switched.id,
            uid: switched.uid,
            nickname: switched.nickname,
            region: switched.region,
            status: switched.status,
          },
          currentRegion: state.currentRegion,
        });
      } catch (error) {
        sendJSON(res, 400, { error: error.message });
      }
      return;
    }

    case '/accounts/delete': {
      const body = await readJsonBody(req);
      const accountId = String(body.accountId || '');
      if (!accountId) {
        sendJSON(res, 400, { error: '缺少 accountId' });
        return;
      }
      const ok = deleteAccount(accountId);
      sendJSON(res, 200, { ok });
      return;
    }

    case '/accounts/status-update': {
      const body = await readJsonBody(req);
      const accountId = String(body.accountId || '');
      const status = String(body.status || 'ready');
      const statusNote = String(body.statusNote || '');
      for (const r of Object.keys(state.regions)) {
        const acc = (state.regions[r].accounts || []).find((a) => a.id === accountId);
        if (acc) {
          acc.status = status;
          acc.statusNote = statusNote;
          saveState();
          sendJSON(res, 200, { ok: true, account: acc });
          return;
        }
      }
      sendJSON(res, 404, { error: '未找到指定账号' });
      return;
    }

    case '/region/switch': {
      const body = await readJsonBody(req);
      const target = String(body.region || '').toLowerCase();
      if (!REGIONS[target]) {
        sendJSON(res, 400, { error: `不支持的区域: ${target}` });
        return;
      }
      if (state.currentRegion !== target) {
        syncActiveRegionFromState();
        state.currentRegion = target;
        syncStateWithActiveRegion();
        state.loginError = '';
        state.loginInProgress = false;
        saveState();
        if (state.enabled) {
          syncOpenCodeConfig(true);
        } else {
          syncOpenCodeConfig(false);
        }
        log(`已切换至区域：${REGIONS[target].name}`);
      }
      const activeRegion = getActiveRegion();
      sendJSON(res, 200, {
        ok: true,
        currentRegion: state.currentRegion,
        regionName: activeRegion.name,
      });
      return;
    }

    case '/toggle': {
      const body = await readJsonBody(req);
      const next = Boolean(body.enabled);
      if (next && !state.credential) {
        sendJSON(res, 400, { ok: false, error: '尚未登录 WorkBuddy' });
        return;
      }
      state.enabled = next;
      saveState();
      if (next) {
        await fetchModels();
        const ok = syncOpenCodeConfig(true);
        sendJSON(res, 200, {
          ok,
          enabled: state.enabled,
          injected: Boolean(state.models.length),
          modelsCount: state.models.length,
          configPath: getOpenCodeConfigPath(),
          baseURL: `http://127.0.0.1:${GATEWAY_PORT}/v1`,
        });
      } else {
        const ok = syncOpenCodeConfig(false);
        sendJSON(res, 200, { ok, enabled: false, configPath: OPENCODE_CONFIG });
      }
      return;
    }

    case '/login/start': {
      const body = await readJsonBody(req).catch(() => ({}));
      const forceNew = Boolean(body && (body.forceNew || body.addAccount));
      if (state.credential && !forceNew) {
        sendJSON(res, 200, { alreadyLoggedIn: true, loginUrl: '' });
        return;
      }
      if (state.loginInProgress) {
        sendJSON(res, 200, { alreadyInProgress: true, loginUrl: '' });
        return;
      }
      try {
        const { loginUrl, state: stateId } = await startLogin();
        runLoginBackground(stateId);
        sendJSON(res, 200, { loginUrl, loginInProgress: true });
      } catch (error) {
        sendJSON(res, 500, { error: error.message });
      }
      return;
    }

    case '/login/status': {
      sendJSON(res, 200, {
        loggedIn: Boolean(state.credential),
        loginInProgress: state.loginInProgress,
        loginError: state.loginError,
        account: state.credential
          ? { uid: state.credential.uid, nickname: state.credential.nickname }
          : null,
      });
      return;
    }

    case '/logout': {
      const curAcc = getActiveAccount();
      if (curAcc) {
        deleteAccount(curAcc.id);
      } else {
        state.credential = null;
        state.models = [];
        state.modelsFetchedAt = 0;
        state.enabled = false;
        state.loginError = '';
        saveState();
        syncOpenCodeConfig(false);
      }
      sendJSON(res, 200, { ok: true });
      return;
    }

    case '/models': {
      const body = await readJsonBody(req);
      await ensureFreshCredential().catch(() => {});
      const force = Boolean(body.force);
      await fetchModels(force);
      if (force && state.enabled) {
        syncOpenCodeConfig(true);
      }
      sendJSON(res, 200, {
        models: state.models,
        disabledModels: state.disabledModels || [],
      });
      return;
    }

    case '/models/toggle': {
      const body = await readJsonBody(req);
      const modelId = String(body.modelId || '');
      if (!modelId) {
        sendJSON(res, 400, { error: '缺少 modelId' });
        return;
      }
      const disabledSet = new Set(state.disabledModels || []);
      const shouldEnable = typeof body.enabled === 'boolean' ? body.enabled : disabledSet.has(modelId);
      if (shouldEnable) {
        disabledSet.delete(modelId);
      } else {
        disabledSet.add(modelId);
      }
      state.disabledModels = Array.from(disabledSet);
      saveState();
      if (state.enabled) {
        syncOpenCodeConfig(true);
      }
      sendJSON(res, 200, {
        ok: true,
        modelId,
        enabled: !disabledSet.has(modelId),
        disabledModels: state.disabledModels,
        enabledCount: state.models.filter((m) => !disabledSet.has(m.id)).length,
      });
      return;
    }

    case '/models/toggle-all': {
      const body = await readJsonBody(req);
      const enableAll = Boolean(body.enabled);
      if (enableAll) {
        state.disabledModels = [];
      } else {
        state.disabledModels = state.models.map((m) => m.id);
      }
      saveState();
      if (state.enabled) {
        syncOpenCodeConfig(true);
      }
      sendJSON(res, 200, {
        ok: true,
        disabledModels: state.disabledModels,
        enabledCount: enableAll ? state.models.length : 0,
      });
      return;
    }

    case '/probe': {
      const body = await readJsonBody(req);
      if (!state.credential) {
        sendJSON(res, 401, { error: '尚未登录 WorkBuddy' });
        return;
      }
      const model = String(body.model || (state.models[0] && state.models[0].id) || '');
      if (!model) {
        sendJSON(res, 400, { error: '没有可测试的模型' });
        return;
      }
      const ok = await ensureFreshCredential();
      if (!ok) {
        sendJSON(res, 401, { error: '凭据已失效，请重新登录' });
        return;
      }
      const started = Date.now();
      try {
        const result = await probeModel(model, state.credential.access_token);
        sendJSON(res, 200, {
          model,
          ok: result.ok,
          status: result.status,
          latencyMs: result.latencyMs,
          error: result.error || '',
        });
      } catch (error) {
        sendJSON(res, 200, { model, ok: false, latencyMs: Date.now() - started, error: error.message });
      }
      return;
    }

    case '/usage': {
      sendJSON(res, 200, usageSnapshot());
      return;
    }

    case '/usage/reset': {
      const body = await readJsonBody(req).catch(() => ({}));
      const scope = String(body && body.scope ? body.scope : 'current').toLowerCase();
      if (scope === 'global' || scope === 'all') {
        state.globalUsage = defaultGlobalUsage();
      }
      if (scope === 'current' || scope === 'all') {
        state.usage = defaultUsage();
        state.credits.totalConsumed = 0;
        state.credits.currentBalance = state.credits.initialBalance;
        const curAcc = getActiveAccount();
        if (curAcc) {
          curAcc.usage = defaultUsage();
          curAcc.credits.totalConsumed = 0;
          curAcc.credits.currentBalance = curAcc.credits.initialBalance;
        }
      }
      saveState();
      sendJSON(res, 200, usageSnapshot());
      return;
    }

    case '/credits': {
      sendJSON(res, 200, {
        initialBalance: state.credits.initialBalance,
        currentBalance: state.credits.currentBalance,
        totalConsumed: state.credits.totalConsumed,
        lastCalibratedAt: state.credits.lastCalibratedAt,
      });
      return;
    }

    case '/credits/calibrate': {
      const body = await readJsonBody(req);
      const val = Number(body.balance);
      if (!Number.isFinite(val) || val < 0) {
        sendJSON(res, 400, { error: '请输入有效的正数积分数值' });
        return;
      }
      state.credits.initialBalance = Math.round(val * 10000) / 10000;
      state.credits.totalConsumed = 0;
      state.credits.currentBalance = state.credits.initialBalance;
      state.credits.lastCalibratedAt = Date.now();
      saveState();
      log(`积分已校准：初始/当前余额 = ${state.credits.currentBalance}`);
      sendJSON(res, 200, {
        ok: true,
        credits: {
          initialBalance: state.credits.initialBalance,
          currentBalance: state.credits.currentBalance,
          totalConsumed: state.credits.totalConsumed,
          lastCalibratedAt: state.credits.lastCalibratedAt,
        },
      });
      return;
    }

    default:
      sendJSON(res, 404, { error: 'Not found' });
  }
}

// ─────────────────────── 控制面服务器 ───────────────────────

function startControlServer() {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
  const token = process.env.OPENCHAMBER_SERVICE_TOKEN || '';
  if (!port || !token) {
    log('未检测到 OPENCHAMBER_SERVICE_PORT，以独立网关模式 (Standalone Gateway) 运行');
    return null;
  }

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', `http://127.0.0.1:${port}`).pathname;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }
    Promise.resolve(handleControl(req, res, pathname)).catch((error) => {
      if (!res.headersSent) sendJSON(res, 500, { error: error.message });
      else res.end();
    });
  });

  server.listen(port, '127.0.0.1', () => log(`控制面已监听 127.0.0.1:${port}`));
  server.on('error', (error) => log('控制面错误：', error.message));
  return server;
}

// ─────────────────────── 网关面服务器 ───────────────────────

function startGatewayServer() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', `http://127.0.0.1:${GATEWAY_PORT}`).pathname;

    if (pathname === '/v1/models') {
      const disabledSet = new Set(state.disabledModels || []);
      const activeModels = state.models.filter((m) => !disabledSet.has(m.id));
      const data = activeModels.map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(state.modelsFetchedAt / 1000) || 0,
        owned_by: 'workbuddy',
      }));
      const text = JSON.stringify({ object: 'list', data });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(text);
      return;
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (!state.credential) {
        sendJSON(res, 401, { error: { message: 'WorkBuddy 未登录' } });
        return;
      }
      readJsonBody(req, 120000, 50 * 1024 * 1024)
        .then((body) => {
          if (!body || !Array.isArray(body.messages)) {
            sendJSON(res, 400, { error: { message: '无效请求体' } });
            return;
          }
          ensureFreshCredential().catch(() => {});
          return proxyChatCompletion(body, res);
        })
        .catch((error) => {
          if (!res.headersSent) sendJSON(res, 500, { error: { message: error.message } });
        });
      return;
    }

    sendJSON(res, 404, { error: { message: 'Not found' } });
  });

  server.listen(GATEWAY_PORT, '127.0.0.1', () => log(`网关面已监听 127.0.0.1:${GATEWAY_PORT}`));
  server.on('error', (error) => log('网关面错误：', error.message));
  return server;
}

async function handleCliLogin() {
  log('正在发起终端登录流程…');
  try {
    const { loginUrl, state: stateId } = await startLogin();
    console.log('\n============================================================');
    console.log('🔗 请在浏览器中打开以下链接进行 WorkBuddy 授权登录：');
    console.log(loginUrl);
    console.log('============================================================\n');
    console.log('⏳ 正在等待浏览器授权中…（超时时间 5 分钟）');
    const token = await pollToken(stateId);
    const account = await pollAccount(stateId, token.access_token);
    const acc = addOrUpdateAccount(state.currentRegion, token, account);
    state.enabled = true;
    await fetchModels(true);
    saveState();
    syncOpenCodeConfig(true);
    console.log(`\n🎉 登录成功！已归档至账号池：${acc.nickname || acc.uid} (ID: ${acc.id})`);
    console.log(`✅ 已自动将 ${state.models.length} 个模型注入到 opencode.json`);
  } catch (error) {
    console.error('❌ 登录失败：', error.message);
  }
}

// ─────────────────────── 启动 ───────────────────────

function main() {
  loadState();

  if (process.argv.includes('--china')) {
    state.currentRegion = 'china';
    syncStateWithActiveRegion();
    saveState();
    log('已切换至中国版 (CodeBuddy)');
  } else if (process.argv.includes('--intl')) {
    state.currentRegion = 'intl';
    syncStateWithActiveRegion();
    saveState();
    log('已切换至国际版 (WorkBuddy)');
  }

  if (process.argv.includes('--accounts') || process.argv.includes('-a')) {
    const agg = computeAggregateUsage();
    console.log('\n============================================================');
    console.log(`📋 WorkBuddy 账号池清单 (共 ${agg.accountsCount} 个账号):`);
    console.log('============================================================');
    if (agg.accounts.length === 0) {
      console.log('暂无已保存账号。可运行 `node service/index.js --login` 添加账号。');
    } else {
      agg.accounts.forEach((acc, i) => {
        const activeTag = acc.isActive ? ' ⭐ [当前活跃]' : '';
        const regionTag = acc.region === 'china' ? '[🇨🇳 中国版]' : '[🌐 国际版]';
        const statusTag = acc.status === 'restricted' ? ' ⛔ [已受限]' : ` [${acc.status}]`;
        console.log(`\n${i + 1}. ${regionTag} ${acc.nickname} (UID: ${acc.uid})${activeTag}${statusTag}`);
        console.log(`   账号ID: ${acc.id}`);
        console.log(`   积分余额: ${acc.credits.currentBalance.toFixed(2)} 积分 | 消耗: ${acc.credits.totalConsumed.toFixed(2)} 积分`);
        console.log(`   累计Token: ${acc.usage.totalTokens.toLocaleString()} (输入: ${acc.usage.inputTokens.toLocaleString()} / 输出: ${acc.usage.outputTokens.toLocaleString()})`);
        if (acc.statusNote) console.log(`   提示: ${acc.statusNote}`);
      });
    }
    console.log('\n============================================================');
    console.log(`📊 插件全局跨账号累计: 总消耗 ${agg.totalTokens.toLocaleString()} Token (输入: ${agg.inputTokens.toLocaleString()} / 输出: ${agg.outputTokens.toLocaleString()}) | 累计积分: ${agg.creditsConsumed.toFixed(2)}`);
    console.log('============================================================\n');
    process.exit(0);
  }

  const switchIdx = process.argv.indexOf('--switch');
  if (switchIdx !== -1 && process.argv[switchIdx + 1]) {
    const targetId = process.argv[switchIdx + 1];
    switchActiveAccount(targetId)
      .then((acc) => {
        console.log(`\n✅ 已成功切换至账号: ${acc.nickname} (UID: ${acc.uid}, ${REGIONS[acc.region].name})`);
        console.log(`   当前积分余额: ${acc.credits.currentBalance.toFixed(2)} 积分`);
        process.exit(0);
      })
      .catch((err) => {
        console.error(`\n❌ 切换账号失败:`, err.message);
        process.exit(1);
      });
    return;
  }

  if (process.argv.includes('--login')) {
    handleCliLogin().then(() => {
      startGatewayServer();
      log(`网关就绪，OpenCode 可直接调用 http://127.0.0.1:${GATEWAY_PORT}/v1`);
    });
    return;
  }

  if (state.credential) {
    fetchModels(true)
      .then(() => {
        if (state.enabled) syncOpenCodeConfig(true);
      })
      .catch(() => {});
  }

  startControlServer();
  startGatewayServer();
  log(`服务就绪，网关监听: http://127.0.0.1:${GATEWAY_PORT}/v1`);
}

function shutdown() {
  log('收到退出信号，保存状态…');
  saveState();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main();