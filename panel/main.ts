import { connectHost } from '@openchamber/sdk';

interface Credits {
  initialBalance: number;
  currentBalance: number;
  totalConsumed: number;
  lastCalibratedAt?: number;
}

interface Model {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  credits?: string;
  isFree?: boolean;
}

interface AccountEntry {
  id: string;
  uid: string;
  nickname: string;
  region: 'intl' | 'china';
  account_type?: string;
  status: 'active' | 'ready' | 'restricted' | 'expired';
  statusNote?: string;
  credits: Credits;
  usage: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
    generationMs: number;
  };
  isActive: boolean;
}

interface GlobalCumulativeUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  creditsConsumed: number;
  avgTokPerSec: number;
}

interface AllAccountsAggregate {
  accountsCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  creditsConsumed: number;
  accounts: AccountEntry[];
}

interface UsageResponse {
  currentAccount?: {
    id: string | null;
    nickname: string;
    uid: string;
    region: string;
    status: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
    avgTokPerSec: number;
    modelStats: Record<string, { requests: number; inputTokens: number; outputTokens: number; creditsConsumed?: number }>;
    credits: Credits;
  };
  globalCumulative?: GlobalCumulativeUsage;
  allAccountsAggregate?: AllAccountsAggregate;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  avgTokPerSec: number;
  modelStats: Record<string, { requests: number; inputTokens: number; outputTokens: number; creditsConsumed?: number }>;
  credits?: Credits;
}

type Usage = UsageResponse;

interface Status {
  currentRegion?: string;
  regionName?: string;
  regions?: Array<{ id: string; name: string; endpoint: string }>;
  enabled: boolean;
  loggedIn: boolean;
  loginInProgress: boolean;
  loginError: string;
  account: { id?: string; uid: string; nickname: string; status?: string; statusNote?: string } | null;
  activeAccountId?: string | null;
  accounts?: AccountEntry[];
  totalAccountsCount?: number;
  modelsCount: number;
  enabledModelsCount?: number;
  disabledModels?: string[];
  gatewayPort: number;
  configPath: string;
  credits?: Credits;
  hardened?: {
    active: boolean;
    appVersion: string;
    cliVersion: string;
    source: string;
    features: string[];
  };
}

type ProbeState = 'pending' | 'ok' | 'fail';

let host: ReturnType<typeof connectHost> | null = null;
try {
  host = connectHost();
} catch (err) {
  console.error('connectHost failed:', err);
}

let enabled = false;
let loggedIn = false;
let models: Model[] = [];
let disabledModels = new Set<string>();
const probes = new Map<string, { state: ProbeState; latencyMs?: number; error?: string }>();

let usageMode: 'current' | 'global' = 'current';
let latestUsage: UsageResponse | null = null;
let accountsList: AccountEntry[] = [];
let activeAccountId: string | null = null;
let isPoolOpen = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM #${id}`);
  return el as T;
};

const fmt = (n: number): string => (Number(n) || 0).toLocaleString('en-US');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setDiag(msg: string, tone: 'normal' | 'ok' | 'err' = 'normal'): void {
  const bar = document.getElementById('diagBar');
  if (!bar) return;
  bar.textContent = msg;
  bar.className = `diag-bar ${tone === 'ok' ? 'ok' : tone === 'err' ? 'err' : ''}`;
}

async function notify(kind: 'info' | 'success' | 'error' | 'warning', message: string): Promise<void> {
  setDiag(message, kind === 'error' ? 'err' : kind === 'success' ? 'ok' : 'normal');
  if (host) {
    const toastKind = kind === 'warning' ? 'info' : kind;
    await host.toast({ kind: toastKind, message }).catch(() => {});
  }
}

// ── 关键修复：DOM 加载后立即绑定所有按钮事件，绝不等 onReady！ ──

function bindEventsImmediately(): void {
  $('enableToggle').addEventListener('click', () => void onToggleClick());
  $('loginButton').addEventListener('click', () => void startLogin());
  $('logoutButton').addEventListener('click', () => void logout());
  $('probeAllButton').addEventListener('click', () => void probeAll());
  $('refreshModelsButton').addEventListener('click', () => void refreshModels(true));
  $('toggleAllModelsButton').addEventListener('click', () => void toggleAllModels());
  $('usageResetButton').addEventListener('click', () => void resetUsage());
  $('calibrateCreditsBtn').addEventListener('click', () => toggleCreditEdit(true));
  $('creditCancelBtn').addEventListener('click', () => toggleCreditEdit(false));
  $('creditSaveBtn').addEventListener('click', () => void saveCalibratedCredits());

  const togglePoolBtn = document.getElementById('togglePoolBtn');
  if (togglePoolBtn) {
    togglePoolBtn.addEventListener('click', () => toggleAccountPoolDrawer());
  }

  const addAccountBtn = document.getElementById('addAccountBtn');
  if (addAccountBtn) {
    addAccountBtn.addEventListener('click', () => void addNewAccount());
  }

  const quickSelect = document.getElementById('quickAccountSelect') as HTMLSelectElement | null;
  if (quickSelect) {
    quickSelect.addEventListener('change', () => void onQuickAccountChange(quickSelect.value));
  }

  const tabCur = document.getElementById('tabCurrentAccount');
  const tabGlob = document.getElementById('tabGlobalCumulative');
  if (tabCur) {
    tabCur.addEventListener('click', () => setUsageTab('current'));
  }
  if (tabGlob) {
    tabGlob.addEventListener('click', () => setUsageTab('global'));
  }

  const input = document.getElementById('creditInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void saveCalibratedCredits();
      if ((e as KeyboardEvent).key === 'Escape') toggleCreditEdit(false);
    });
  }
  const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement | null;
  if (regionSelect) {
    regionSelect.addEventListener('change', () => void onRegionChange(regionSelect.value));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bindEventsImmediately();
    void refreshAll();
  });
} else {
  bindEventsImmediately();
  void refreshAll();
}

// ── 定时轮询与视窗唤醒：实时同步积分余额与用量 ──
setInterval(() => {
  if (!document.hidden) {
    void refreshUsage();
  }
}, 3000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    void refreshAll();
  }
});
window.addEventListener('focus', () => {
  void refreshAll();
});

if (host) {
  host.onReady((ctx) => {
    document.body.dataset.ocTheme = ctx.theme.mode;
    document.body.dataset.ocSurface = ctx.surface;
    void refreshAll();
  });
}

// ── 服务请求封装 ──

async function serviceRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  opts: { silent?: boolean; timeoutMs?: number } = {},
): Promise<T | null> {
  if (!host) {
    setDiag('错误：无法连接 OpenChamber Host SDK', 'err');
    return null;
  }
  try {
    const res = await withTimeout(
      host.serviceRequest({
        method,
        path,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      opts.timeoutMs ?? 15000,
      `${method} ${path}`,
    );
    const payload = typeof res.body === 'string' ? safeParse(res.body) : res.body;
    if (res.status >= 400) {
      const msg = (payload as { error?: string } | null)?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return payload as T;
  } catch (error: any) {
    const code = error?.code ? `[${error.code}] ` : '';
    const message = error instanceof Error ? error.message : String(error);
    const fullMsg = `${code}${message}`;
    if (!opts.silent) {
      if (error?.code === 'NO_SERVICE') {
        await notify('error', '未授予后台服务权限！请在「设置 → 扩展」中点击 WorkBuddy 的 Approve/允许 按钮');
      } else {
        await notify('error', `服务调用失败：${fullMsg}`);
      }
    } else {
      setDiag(`后台通信异常：${fullMsg}`, 'err');
    }
    return null;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms / 1000}s)`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── 状态与数据刷新 ──

async function refreshAll(): Promise<void> {
  await refreshStatus();
  await Promise.all([refreshUsage(), refreshModels(false)]);
}

async function refreshStatus(): Promise<void> {
  const status = await serviceRequest<Status>('GET', '/status', undefined, { silent: true });
  if (!status) {
    renderStatus(null);
    return;
  }
  enabled = status.enabled;
  loggedIn = status.loggedIn;
  if (Array.isArray(status.disabledModels)) {
    disabledModels = new Set(status.disabledModels);
  }
  renderStatus(status);
  const activeCount = status.enabledModelsCount ?? status.modelsCount;
  setDiag(
    status.loggedIn
      ? `🟢 后台服务正常 · 网关 127.0.0.1:${status.gatewayPort} · 共 ${status.modelsCount} 个模型（已开启 ${activeCount}）`
      : '🟡 后台服务已就绪 · 请点击下方蓝色按钮完成授权或自动导入凭证',
    status.loggedIn ? 'ok' : 'normal',
  );
}

async function refreshModels(force = false): Promise<void> {
  const btn = document.getElementById('refreshModelsButton') as HTMLButtonElement | null;
  if (force && btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>刷新中…';
  }
  try {
    const res = await serviceRequest<{
      models: Model[];
      disabledModels: string[];
    } | Model[]>('POST', '/models', { force }, { silent: !force });

    if (!res) return;

    if (Array.isArray(res)) {
      models = res;
    } else if (res && typeof res === 'object') {
      models = Array.isArray(res.models) ? res.models : [];
      if (Array.isArray(res.disabledModels)) {
        disabledModels = new Set(res.disabledModels);
      }
    }

    renderModels();

    if (force) {
      await notify('success', `🎉 已从 WorkBuddy 同步最新模型列表（共 ${models.length} 个）`);
    }
  } finally {
    if (force && btn) {
      btn.disabled = false;
      btn.textContent = '🔄 刷新列表';
    }
  }
}

async function refreshUsage(): Promise<void> {
  const usage = await serviceRequest<Usage>('GET', '/usage', undefined, { silent: true });
  if (usage) renderUsage(usage);
}

async function onRegionChange(regionId: string): Promise<void> {
  const isChina = regionId === 'china';
  setDiag(`正在切换至 ${isChina ? '🇨🇳 中国版 (CodeBuddy)' : '🌐 国际版 (WorkBuddy)'}…`);
  const res = await serviceRequest<{ ok: boolean; currentRegion: string; regionName: string }>('POST', '/region/switch', { region: regionId });
  if (res && res.ok) {
    probes.clear();
    await refreshAll();
    await notify('info', `已成功切换为 ${res.regionName || (isChina ? '🇨🇳 中国版' : '🌐 国际版')}`);
  }
}

// ── UI 渲染 ──

function renderStatus(status: Status | null): void {
  const badge = $('statusBadge');
  const info = $('accountInfo');
  const loginBtn = $<HTMLButtonElement>('loginButton');
  const logoutBtn = $('logoutButton');
  const hint = $('configHint');
  const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement | null;
  const headerTitle = document.getElementById('headerTitle');
  const isChina = status?.currentRegion === 'china';

  if (regionSelect && status?.currentRegion) {
    regionSelect.value = status.currentRegion;
  }
  if (headerTitle) {
    headerTitle.textContent = isChina ? 'CodeBuddy 中国版' : 'WorkBuddy 国际版';
  }

  const hardenedBadge = document.getElementById('hardenedBadge');
  if (hardenedBadge) {
    if (status?.hardened?.active) {
      hardenedBadge.classList.remove('hidden');
      const appVer = status.hardened.appVersion || '自适应';
      const cliVer = status.hardened.cliVersion || '自适应';
      hardenedBadge.title = `🛡️ 协议加固运行中 (${status.hardened.source})\n• 版本自适应同步: WorkBuddy ${appVer} / CLI ${cliVer}\n• 角色特征打断: System/Dev 提示词中和及零宽字符隔断\n• 11140封号熔断隔绝: 立即隔离单账号，禁止多账号重试连坐\n• 6004模型迂回: 单模型遇限流自动平滑切换候选模型`;
    } else {
      hardenedBadge.classList.add('hidden');
    }
  }

  if (status && status.accounts) {
    renderAccounts(status.accounts, status.activeAccountId || null);
  }

  if (!status) {
    badge.className = 'badge off';
    badge.textContent = '服务未响应';
    info.textContent = '请确认已在「设置 → 扩展」中批准权限，或点击下方按钮重试';
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    setToggle(false);
    return;
  }

  if (!status.loggedIn) {
    badge.className = 'badge off';
    badge.textContent = status.loginInProgress ? '等待授权…' : '未连接';
    info.textContent = status.loginError
      ? `提示：${status.loginError}`
      : (isChina
          ? '未检测到国内版凭证，点击下方按钮在浏览器完成微信扫码授权（自动接入）'
          : '未检测到国际版凭证，点击下方按钮在浏览器完成 WorkBuddy 账号授权（后续永久免登）');
    loginBtn.textContent = isChina ? '📱 微信扫码授权 / 自动接入' : '一键授权 / 自动免密接入';
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    setToggle(false);
    hint.classList.add('hidden');
    return;
  }

  const isRestricted = status.account?.status === 'restricted';
  const isExpired = status.account?.status === 'expired';

  if (isRestricted) {
    badge.className = 'badge off';
    badge.textContent = '⛔ 账号受限 (11140)';
  } else if (isExpired) {
    badge.className = 'badge off';
    badge.textContent = '⚠️ 凭证失效';
  } else {
    badge.className = 'badge ok';
    badge.textContent = '已就绪';
  }

  const name = status.account?.nickname || (isChina ? 'CodeBuddy 用户' : 'WorkBuddy 国际版用户');
  const note = status.account?.statusNote ? `<div style="color:var(--error);font-size:11px;margin-top:4px;">⚠️ ${status.account.statusNote}（可点击账号池切换其他账号使用）</div>` : '';
  info.innerHTML = `<div>${name}${status.account?.uid ? ` <span style="font-size:11px;color:var(--muted); font-family:ui-monospace,Menlo,monospace;">(${status.account.uid})</span>` : ''}</div>${note}`;
  loginBtn.classList.add('hidden');
  logoutBtn.classList.remove('hidden');
  $('loginUrlBox').classList.add('hidden');

  setToggle(status.enabled);
  if (status.credits) {
    renderCredits(status.credits);
  }
  if (status.enabled && status.configPath) {
    hint.classList.remove('hidden');
    const providerLabel = isChina ? 'provider.workbuddy (CodeBuddy CN)' : 'provider.workbuddy (WorkBuddy Intl)';
    hint.textContent = `✅ 已注入 ${status.configPath} → ${providerLabel} (127.0.0.1:${status.gatewayPort})`;
  } else {
    hint.classList.add('hidden');
  }
}

function renderAccounts(accounts: AccountEntry[], currentActiveId: string | null): void {
  accountsList = accounts;
  activeAccountId = currentActiveId;

  const countEl = document.getElementById('accountPoolCount');
  if (countEl) countEl.textContent = String(accounts.length);

  const quickBar = document.getElementById('quickAccountBar');
  const quickSelect = document.getElementById('quickAccountSelect') as HTMLSelectElement | null;

  if (quickBar && quickSelect) {
    if (accounts.length > 0) {
      quickBar.classList.remove('hidden');
      quickSelect.innerHTML = '';
      for (const acc of accounts) {
        const opt = document.createElement('option');
        opt.value = acc.id;
        const regionTag = acc.region === 'china' ? '🇨🇳 中国' : '🌐 国际';
        const balance = acc.credits?.currentBalance != null ? `${acc.credits.currentBalance.toFixed(1)}分` : '';
        const statusText = acc.status === 'restricted' ? ' [⛔受限]' : (acc.status === 'expired' ? ' [⚠️过期]' : '');
        opt.textContent = `${regionTag} · ${acc.nickname || acc.uid} (${balance})${statusText}`;
        if (acc.id === currentActiveId || acc.isActive) {
          opt.selected = true;
        }
        quickSelect.appendChild(opt);
      }
    } else {
      quickBar.classList.add('hidden');
    }
  }

  const container = document.getElementById('accountListContainer');
  if (!container) return;
  container.innerHTML = '';

  if (accounts.length === 0) {
    container.innerHTML = '<div class="muted" style="font-size:12px; padding:6px 0;">账号池暂无账号，点击右上角「+ 添加新账号」接入。</div>';
    return;
  }

  for (const acc of accounts) {
    const isCur = acc.id === currentActiveId || acc.isActive;
    const card = document.createElement('div');
    card.className = `account-card ${isCur ? 'active' : ''} ${acc.status === 'restricted' ? 'restricted' : ''}`;

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.flexDirection = 'column';
    left.style.gap = '2px';
    left.style.minWidth = '0';
    left.style.flex = '1';

    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'center';
    titleRow.style.gap = '6px';

    const tag = document.createElement('span');
    tag.className = `account-tag ${acc.region === 'china' ? 'china' : 'intl'}`;
    tag.textContent = acc.region === 'china' ? '🇨🇳 中国' : '🌐 国际';

    const name = document.createElement('span');
    name.style.fontSize = '12px';
    name.style.fontWeight = '600';
    name.style.whiteSpace = 'nowrap';
    name.style.overflow = 'hidden';
    name.style.textOverflow = 'ellipsis';
    name.textContent = acc.nickname || acc.uid;

    const badge = document.createElement('span');
    badge.className = `account-badge ${acc.status || 'ready'}`;
    badge.textContent = isCur ? '🟢 活跃' : (acc.status === 'restricted' ? '⛔ 11140受限' : (acc.status === 'expired' ? '⚠️ 已过期' : '就绪'));

    titleRow.append(tag, name, badge);

    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.style.fontSize = '11px';
    const balanceStr = acc.credits ? `${acc.credits.currentBalance.toFixed(2)} 积分` : '0 积分';
    const tokensStr = acc.usage ? `${fmt(acc.usage.totalTokens)} tok` : '0 tok';
    sub.textContent = `余额: ${balanceStr} · 用量: ${tokensStr} (${acc.usage?.requestCount || 0}次)`;

    left.append(titleRow, sub);

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '4px';
    right.style.flex = 'none';

    if (!isCur) {
      const switchBtn = document.createElement('button');
      switchBtn.className = 'small primary';
      switchBtn.textContent = '切换';
      switchBtn.style.padding = '3px 8px';
      switchBtn.style.fontSize = '11px';
      switchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void switchAccount(acc.id);
      });
      right.appendChild(switchBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'small';
    delBtn.textContent = '✕';
    delBtn.title = '从账号池移除';
    delBtn.style.padding = '3px 6px';
    delBtn.style.fontSize = '11px';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteAccount(acc.id, acc.nickname || acc.uid);
    });
    right.appendChild(delBtn);

    card.append(left, right);
    container.appendChild(card);
  }
}

function toggleAccountPoolDrawer(): void {
  isPoolOpen = !isPoolOpen;
  const drawer = document.getElementById('accountPoolDrawer');
  if (drawer) {
    drawer.classList.toggle('hidden', !isPoolOpen);
  }
}

async function switchAccount(accountId: string): Promise<void> {
  setDiag('正在切换活跃账号…');
  const res = await serviceRequest<{
    ok: boolean;
    account: { id: string; uid: string; nickname: string; region: string };
    currentRegion: string;
  }>('POST', '/accounts/switch', { accountId });

  if (res && res.ok) {
    probes.clear();
    await refreshAll();
    await notify('success', `🎉 已成功切换至账号：${res.account.nickname || res.account.uid}`);
  }
}

async function onQuickAccountChange(accountId: string): Promise<void> {
  if (accountId && accountId !== activeAccountId) {
    await switchAccount(accountId);
  }
}

async function deleteAccount(accountId: string, name: string): Promise<void> {
  const confirmMsg = `确定从账号池中移除账号「${name}」吗？`;
  if (!confirm(confirmMsg)) return;

  const res = await serviceRequest<{ ok: boolean }>('POST', '/accounts/delete', { accountId });
  if (res && res.ok) {
    await refreshAll();
    await notify('info', `已移除账号 ${name}`);
  }
}

async function addNewAccount(): Promise<void> {
  const urlBox = $('loginUrlBox');
  setDiag('正在启动新账号授权流程…');
  try {
    const result = await serviceRequest<{
      loginUrl: string;
      loginInProgress?: boolean;
    }>('POST', '/login/start', { forceNew: true });

    if (result && result.loginUrl) {
      urlBox.classList.remove('hidden');
      urlBox.innerHTML = `已在系统浏览器打开新账号授权页。若未自动弹出，请访问：<br><a href="${result.loginUrl}" target="_blank" style="color:var(--primary);text-decoration:underline;">点击进行新账号授权</a>`;
      if (host) {
        await host.openUrl(result.loginUrl).catch(() => {});
        await host.writeClipboard(result.loginUrl).catch(() => {});
      }
      await notify('info', '已打开浏览器授权页，登录新账号后将自动添加至账号池！');
      await waitForLogin();
    }
  } catch (err: any) {
    await notify('error', `发起登录失败: ${err.message}`);
  }
}

function setUsageTab(tab: 'current' | 'global'): void {
  usageMode = tab;
  if (latestUsage) {
    renderUsage(latestUsage);
  }
}

function setToggle(on: boolean): void {
  const toggle = $('enableToggle');
  toggle.classList.toggle('on', on);
  toggle.setAttribute('aria-checked', String(on));
}

function renderModels(): void {
  const grid = $('modelsGrid');
  grid.textContent = '';
  const enabledCount = models.filter((m) => !disabledModels.has(m.id)).length;
  const countEnabledEl = document.getElementById('modelsEnabledCount');
  const countTotalEl = document.getElementById('modelsTotalCount');
  if (countEnabledEl) countEnabledEl.textContent = String(enabledCount);
  if (countTotalEl) countTotalEl.textContent = String(models.length);

  if (models.length === 0) {
    grid.innerHTML = '<div class="muted">暂无模型（请先连接账号并点击右上角开关）</div>';
    return;
  }
  for (const model of models) {
    const isEnabled = !disabledModels.has(model.id);

    const row = document.createElement('div');
    row.className = `model ${isEnabled ? '' : 'disabled'}`;
    row.dataset.modelId = model.id;

    // 左侧：独立开关 + 模型名称与ID
    const left = document.createElement('div');
    left.className = 'model-left';

    const toggle = document.createElement('div');
    toggle.className = `mini-toggle ${isEnabled ? 'on' : ''}`;
    toggle.title = isEnabled ? '点击停用此模型（将不在 OpenChamber 显示）' : '点击开启此模型';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(isEnabled));
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      void toggleSingleModel(model.id);
    });

    const info = document.createElement('div');
    info.className = 'model-info';

    const name = document.createElement('div');
    name.className = 'model-name';
    name.textContent = model.name || model.id;

    if (model.credits) {
      const tag = document.createElement('span');
      tag.className = `credit-tag ${model.isFree ? 'free' : ''}`;
      tag.textContent = model.isFree ? (model.credits.includes('0') ? model.credits : '限免 0x') : model.credits;
      name.append(tag);
    }

    const id = document.createElement('div');
    id.className = 'model-id';
    id.textContent = model.id;

    info.append(name, id);
    left.append(toggle, info);

    // 右侧：上下文与测速
    const right = document.createElement('div');
    right.className = 'model-right';
    right.title = '点击测速此模型';

    const meta = document.createElement('div');
    meta.className = 'model-meta';
    const ctxLabel = model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : '128K';
    meta.textContent = model.supportsImages ? `${ctxLabel} · 视觉` : ctxLabel;

    const status = document.createElement('div');
    status.className = 'model-meta';
    status.dataset.probeFor = model.id;
    status.textContent = '点击测速';

    right.append(meta, status);
    right.addEventListener('click', (e) => {
      e.stopPropagation();
      void probeOne(model.id);
    });

    row.append(left, right);
    grid.append(row);
  }
  paintProbes();
}

async function toggleSingleModel(modelId: string): Promise<void> {
  const willEnable = disabledModels.has(modelId);
  const result = await serviceRequest<{
    ok: boolean;
    enabled: boolean;
    disabledModels: string[];
    enabledCount: number;
  }>('POST', '/models/toggle', { modelId, enabled: willEnable });

  if (result && result.ok) {
    disabledModels = new Set(result.disabledModels || []);
    renderModels();
    setDiag(
      willEnable ? `已启用模型 ${modelId}，配置已同步` : `已隐藏/停用模型 ${modelId}，配置已同步`,
      'normal',
    );
  }
}

async function toggleAllModels(): Promise<void> {
  const activeCount = models.filter((m) => !disabledModels.has(m.id)).length;
  const targetEnableAll = activeCount < models.length;
  const result = await serviceRequest<{
    ok: boolean;
    disabledModels: string[];
    enabledCount: number;
  }>('POST', '/models/toggle-all', { enabled: targetEnableAll });

  if (result && result.ok) {
    disabledModels = new Set(result.disabledModels || []);
    renderModels();
    await notify('info', targetEnableAll ? `已全部启用共 ${models.length} 个模型` : '已停用全部模型');
  }
}

function paintProbes(): void {
  for (const [id, result] of probes) {
    const nodes = document.querySelectorAll<HTMLElement>('[data-probe-for]');
    for (const node of Array.from(nodes)) {
      if (node.dataset.probeFor !== id) continue;
      if (result.state === 'pending') {
        node.innerHTML = '<span class="spinner"></span>测速中';
        node.style.color = 'var(--warning)';
      } else if (result.state === 'ok') {
        node.textContent = `🟢 ${result.latencyMs ?? 0} ms`;
        node.style.color = 'var(--success)';
      } else {
        node.textContent = `🔴 ${(result.error || '失败').slice(0, 32)}`;
        node.style.color = 'var(--error)';
      }
    }
  }
}

function renderCredits(credits?: Credits): void {
  const balanceEl = document.getElementById('creditBalanceVal');
  const consumedEl = document.getElementById('creditConsumedVal');
  const statCreditsEl = document.getElementById('statCreditsConsumed');
  if (!credits) return;

  const current = Number(credits.currentBalance) || 0;
  const consumed = Number(credits.totalConsumed) || 0;

  if (balanceEl) balanceEl.textContent = current.toFixed(2);
  if (consumedEl) consumedEl.textContent = consumed.toFixed(2);
  if (statCreditsEl) statCreditsEl.textContent = consumed.toFixed(2);
}

function toggleCreditEdit(show: boolean): void {
  const box = document.getElementById('creditEditBox');
  const input = document.getElementById('creditInput') as HTMLInputElement | null;
  if (!box) return;
  if (show) {
    box.classList.remove('hidden');
    if (input) {
      const balanceEl = document.getElementById('creditBalanceVal');
      input.value = balanceEl?.textContent?.trim() || '100.00';
      input.focus();
      input.select();
    }
  } else {
    box.classList.add('hidden');
  }
}

async function saveCalibratedCredits(): Promise<void> {
  const input = document.getElementById('creditInput') as HTMLInputElement | null;
  if (!input) return;
  const val = parseFloat(input.value.trim());
  if (isNaN(val) || val < 0) {
    await notify('warning', '请输入大于或等于 0 的有效积分数值');
    return;
  }
  const res = await serviceRequest<{ ok: boolean; credits: Credits }>('POST', '/credits/calibrate', { balance: val });
  if (res && res.ok) {
    renderCredits(res.credits);
    toggleCreditEdit(false);
    await notify('success', `🎉 积分余额已校准并同步为 ${val.toFixed(2)} 积分`);
  }
}

function renderModelBars(modelStats: Record<string, { requests: number; inputTokens: number; outputTokens: number; creditsConsumed?: number }>): void {
  const bars = $('usageBars');
  bars.textContent = '';
  const entries = Object.entries(modelStats || {}).sort(
    (a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens),
  );
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.fontSize = '11px';
    empty.textContent = '暂无调用记录';
    bars.append(empty);
    return;
  }
  const max = Math.max(1, ...entries.map(([, v]) => (v.inputTokens || 0) + (v.outputTokens || 0)));
  for (const [modelId, stat] of entries) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const inT = stat.inputTokens || 0;
    const outT = stat.outputTokens || 0;
    const total = inT + outT;
    const label = document.createElement('div');
    const creditsStr = stat.creditsConsumed ? ` · 扣除 ${stat.creditsConsumed.toFixed(2)} 积分` : '';
    label.textContent = `${modelId} · ${fmt(total)} tok (入 ${fmt(inT)} / 出 ${fmt(outT)}) · ${stat.requests} 次${creditsStr}`;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.round((total / max) * 100)}%`;
    track.append(fill);
    row.append(label, track);
    bars.append(row);
  }
}

function renderUsage(usage: UsageResponse): void {
  latestUsage = usage;

  const isGlobal = usageMode === 'global';

  const tabCur = document.getElementById('tabCurrentAccount');
  const tabGlob = document.getElementById('tabGlobalCumulative');
  if (tabCur && tabGlob) {
    tabCur.classList.toggle('active', !isGlobal);
    tabGlob.classList.toggle('active', isGlobal);
  }

  const nameEl = document.getElementById('usageAccountName');
  const rateLabel = document.getElementById('statRateLabel');

  if (isGlobal) {
    const gu = usage.globalCumulative || {
      totalTokens: usage.totalTokens || 0,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      requestCount: usage.requestCount || 0,
      creditsConsumed: 0,
      avgTokPerSec: 0,
    };
    const agg = usage.allAccountsAggregate;
    const accCount = agg?.accountsCount || accountsList.length || 1;

    if (nameEl) nameEl.textContent = `插件跨账号全局累计 (共 ${accCount} 个账号历史汇总)`;
    if (rateLabel) rateLabel.textContent = '全局 tok/s';

    $('statTokens').textContent = fmt(gu.totalTokens);
    $('statRequests').textContent = fmt(gu.requestCount);
    $('statRate').textContent = gu.avgTokPerSec ? String(gu.avgTokPerSec) : '0';
    $('statInput').textContent = fmt(gu.inputTokens);
    $('statOutput').textContent = fmt(gu.outputTokens);

    const consumed = gu.creditsConsumed || agg?.creditsConsumed || 0;
    const statCreditsEl = document.getElementById('statCreditsConsumed');
    if (statCreditsEl) statCreditsEl.textContent = consumed.toFixed(2);

    renderModelBars(usage.modelStats || {});
  } else {
    const cur = usage.currentAccount || {
      nickname: '',
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      requestCount: usage.requestCount,
      avgTokPerSec: usage.avgTokPerSec,
      modelStats: usage.modelStats,
      credits: usage.credits,
    };

    if (nameEl) nameEl.textContent = cur.nickname ? `${cur.nickname} (${cur.region === 'china' ? '中国版' : '国际版'})` : '当前激活账号';
    if (rateLabel) rateLabel.textContent = '平均 tok/s';

    $('statTokens').textContent = fmt(cur.totalTokens);
    $('statRequests').textContent = fmt(cur.requestCount);
    $('statRate').textContent = cur.avgTokPerSec ? String(cur.avgTokPerSec) : '0';
    $('statInput').textContent = fmt(cur.inputTokens);
    $('statOutput').textContent = fmt(cur.outputTokens);

    if (cur.credits) {
      renderCredits(cur.credits);
    }

    renderModelBars(cur.modelStats || usage.modelStats || {});
  }
}

// ── 按钮交互处理 ──

async function onToggleClick(): Promise<void> {
  setDiag('正在切换开关状态…');
  if (!loggedIn) {
    await startLogin();
    return;
  }
  const next = !enabled;
  const result = await serviceRequest<{ ok: boolean; modelsCount?: number }>('POST', '/toggle', {
    enabled: next,
  });
  if (!result) return;
  enabled = next;
  setToggle(enabled);
  await notify(
    next ? 'success' : 'info',
    next
      ? `✅ 已开启 WorkBuddy 并注入 ${result.modelsCount ?? 0} 个模型到 OpenChamber！`
      : '已关闭 WorkBuddy 渠道',
  );
  await refreshAll();
}

async function startLogin(): Promise<void> {
  const btn = $<HTMLButtonElement>('loginButton');
  const urlBox = $('loginUrlBox');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>正在嗅探本机凭证 / 生成授权链接…';
  setDiag('正在请求后台 /login/start …');

  try {
    const result = await serviceRequest<{
      loginUrl: string;
      alreadyLoggedIn?: boolean;
      autoImported?: boolean;
    }>('POST', '/login/start');

    if (!result) {
      btn.disabled = false;
      btn.textContent = '一键授权 / 自动免密接入';
      return;
    }

    if (result.alreadyLoggedIn || result.autoImported) {
      await notify('success', '🎉 已自动识别本机 WorkBuddy 免密凭证并开启渠道！');
      await refreshAll();
      btn.disabled = false;
      btn.textContent = '一键授权 / 自动免密接入';
      return;
    }

    if (result.loginUrl) {
      urlBox.classList.remove('hidden');
      urlBox.innerHTML = `已在系统浏览器打开登录页。若未自动弹出，请点此复制链接在浏览器打开：<br><a href="${result.loginUrl}" target="_blank" style="color:var(--primary);text-decoration:underline;">点击或复制此授权链接</a>`;
      if (host) {
        await host.openUrl(result.loginUrl).catch(() => {});
        await host.writeClipboard(result.loginUrl).catch(() => {});
      }
      await notify('info', '已打开浏览器授权页（同时已复制链接到剪贴板），登录完成后将自动接入！');
    }

    btn.innerHTML = '<span class="spinner"></span>等待浏览器完成登录…';
    await waitForLogin();
  } finally {
    btn.disabled = false;
    btn.textContent = '一键授权 / 自动免密接入';
  }
}

async function waitForLogin(): Promise<void> {
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const status = await serviceRequest<Status>('GET', '/login/status', undefined, { silent: true });
    if (!status) continue;
    if (status.loggedIn) {
      await notify('success', `🎉 登录成功并已自动注入模型！欢迎 ${status.account?.nickname || ''}`);
      await refreshAll();
      return;
    }
    if (status.loginError && !status.loginInProgress) {
      await notify('error', `登录失败：${status.loginError}`);
      return;
    }
  }
  await notify('error', '等待登录超时，请重试');
}

async function logout(): Promise<void> {
  const result = await serviceRequest<{ ok: boolean }>('POST', '/logout');
  if (!result) return;
  probes.clear();
  enabled = false;
  loggedIn = false;
  models = [];
  await refreshAll();
  await notify('info', '已退出 WorkBuddy 账号');
}

async function probeAll(): Promise<void> {
  if (!loggedIn) {
    await notify('warning', '请先连接 WorkBuddy 账号后再测速');
    return;
  }
  if (models.length === 0) {
    await refreshModels(true);
    if (models.length === 0) return;
  }
  const targetModels = models.filter((m) => !disabledModels.has(m.id));
  if (targetModels.length === 0) {
    await notify('warning', '当前未开启任何模型，请先开启需要测速的模型');
    return;
  }
  const btn = $<HTMLButtonElement>('probeAllButton');
  btn.disabled = true;
  probes.clear();
  targetModels.forEach((m) => probes.set(m.id, { state: 'pending' }));
  paintProbes();

  const queue = targetModels.slice();
  const CONCURRENCY = 3;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const model = queue.shift();
      if (model) await runProbe(model.id);
    }
  });
  await Promise.all(workers);

  btn.disabled = false;
  const okCount = [...probes.values()].filter((p) => p.state === 'ok').length;
  await notify(
    okCount > 0 ? 'success' : 'error',
    `测速完成：${okCount}/${targetModels.length} 个启用模型可用`,
  );
}

async function probeOne(modelId: string): Promise<void> {
  probes.set(modelId, { state: 'pending' });
  paintProbes();
  await runProbe(modelId);
}

async function runProbe(modelId: string): Promise<void> {
  const result = await serviceRequest<{ ok: boolean; latencyMs?: number; error?: string }>(
    'POST',
    '/probe',
    { model: modelId },
    { silent: true, timeoutMs: 60000 },
  );
  probes.set(
    modelId,
    result
      ? { state: result.ok ? 'ok' : 'fail', latencyMs: result.latencyMs, error: result.error }
      : { state: 'fail', error: '超时或未响应' },
  );
  paintProbes();
}

async function resetUsage(): Promise<void> {
  const isGlobal = usageMode === 'global';
  const confirmText = isGlobal
    ? '确定清空插件【全局跨账号历史累计】用量统计吗？'
    : '确定清空【当前激活账号】的用量统计吗？';
  if (!confirm(confirmText)) return;

  const usage = await serviceRequest<UsageResponse>('POST', '/usage/reset', { scope: isGlobal ? 'global' : 'current' });
  if (usage) {
    renderUsage(usage);
    await notify('info', isGlobal ? '已清空插件全局累计用量' : '已清空当前账号用量');
  }
}
