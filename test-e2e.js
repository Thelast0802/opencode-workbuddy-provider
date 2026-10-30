#!/usr/bin/env node
/**
 * WorkBuddy 服务端到端测试
 *
 * 用本地 mock 上游（WORKBUDDY_ENDPOINT 指向它）隔离外网，
 * 并把 HOME 指向临时目录，避免污染真实 ~/.config/opencode/opencode.json。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT || 41277);
const GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT || 41278); // 独立网关端口，避免与真实实例冲突
const TOKEN = 'e2e-test-token';
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT || 41279);

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-'));
const CONFIG_DIR = path.join(TMP_HOME, '.config', 'opencode');
const CONFIG_FILE = path.join(CONFIG_DIR, 'opencode.json');

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function request(port, method, urlPath, { body, token, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () =>
          raw
            ? resolve({ status: res.statusCode, headers: res.headers, body: data })
            : resolve({ status: res.statusCode, body: data ? safeParse(data) : null }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('client timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock 上游 ──
const MOCK_MODELS = [
  { id: 'gpt-5.5', name: 'GPT-5.5', maxInputTokens: 1000000, maxOutputTokens: 128000, supportsImages: true },
  { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1000000, maxOutputTokens: 48000, supportsImages: true },
  { id: 'auto', name: 'Auto' },
  { id: 'nes-legacy', name: 'NES' },
];

function startMockUpstream() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const p = req.url.split('?')[0];
        if (p === '/v2/plugin/auth/state') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { state: 'state-123', authUrl: 'https://example.test/login' } }));
        } else if (p === '/v2/plugin/auth/token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { accessToken: 'mock-access', refreshToken: 'mock-refresh', expiresIn: 7200 } }));
        } else if (p === '/v2/plugin/login/account') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { uid: 'uid-1', nickname: 'Tester', type: 'personal' } }));
        } else if (p === '/v3/config') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: {
                agents: [{ name: 'craft', models: ['gpt-5.5'] }],
                models: MOCK_MODELS,
              },
            }),
          );
        } else if (p === '/v2/chat/completions') {
          const parsed = safeParse(body) || {};
          if (parsed.stream === false) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' } }] }));
            return;
          }
          // SSE：故意用 application/json 头返回 SSE 帧，验证嗅探逻辑
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
          setTimeout(() => res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'), 60);
          setTimeout(() => res.end('data: [DONE]\n\n'), 120);
        } else {
          res.writeHead(404);
          res.end('{}');
        }
      });
    });
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ── 测试主体 ──
async function main() {
  console.log(`临时 HOME: ${TMP_HOME}\n`);

  // 预置一个已存在的 opencode.json，验证不破坏用户其它 provider
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { mine: { npm: '@ai-sdk/openai' } } }, null, 2),
  );

  const mock = await startMockUpstream();
  console.log('mock 上游已启动 :%d\n', MOCK_PORT);

  const service = spawn(process.execPath, [path.join(__dirname, 'service', 'index.js')], {
    env: {
      ...process.env,
      HOME: TMP_HOME,
      OPENCHAMBER_SERVICE_PORT: String(CONTROL_PORT),
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      WORKBUDDY_ENDPOINT: `http://127.0.0.1:${MOCK_PORT}`,
      WORKBUDDY_GATEWAY_PORT: String(GATEWAY_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serviceLog = [];
  service.stdout.on('data', (d) => serviceLog.push(String(d)));
  service.stderr.on('data', (d) => serviceLog.push(String(d)));

  await sleep(1200);

  try {
    // ── 测试 1：/health ──
    console.log('测试 1：/health 与鉴权');
    const health = await request(CONTROL_PORT, 'GET', '/health', { token: TOKEN });
    check('/health 带鉴权返回 200', health.status === 200);
    const noAuth = await request(CONTROL_PORT, 'GET', '/health');
    check('/health 无鉴权返回 401', noAuth.status === 401);

    // ── 测试 2：无 body 的 POST /login/start 不卡死 ──
    console.log('\n测试 2：无 body 的 POST /login/start（回归原死锁 Bug）');
    const t0 = Date.now();
    const login = await request(CONTROL_PORT, 'POST', '/login/start', { token: TOKEN });
    const elapsed = Date.now() - t0;
    check(`POST /login/start 在 1 秒内返回（实测 ${elapsed}ms）`, elapsed < 1000, `${elapsed}ms`);
    check('/login/start 返回 200', login.status === 200, JSON.stringify(login.body));
    check(
      '/login/start 返回了 loginUrl',
      Boolean(login.body && login.body.loginUrl),
      JSON.stringify(login.body),
    );

    // 等待后台轮询完成登录
    let loggedIn = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const s = await request(CONTROL_PORT, 'GET', '/login/status', { token: TOKEN });
      if (s.body && s.body.loggedIn) {
        loggedIn = true;
        break;
      }
    }
    check('后台轮询完成登录并写入凭据', loggedIn);

    // ── 测试 3：模型列表拉取 + 过滤 ──
    console.log('\n测试 3：模型列表');
    const modelsRes = await request(CONTROL_PORT, 'GET', '/models', { token: TOKEN });
    const modelsData = modelsRes.body;
    const models = Array.isArray(modelsData) ? modelsData : (modelsData && modelsData.models ? modelsData.models : []);
    check('返回 2 个模型（auto / nes-legacy 已过滤）', models.length === 2, `实际 ${models.length}`);
    check(
      '包含 gpt-5.5 且带上下文窗口',
      models.some((m) => m.id === 'gpt-5.5' && m.contextWindow === 1000000),
      JSON.stringify(models),
    );

    // ── 测试 4：/toggle 注入 opencode.json ──
    console.log('\n测试 4：POST /toggle 注入 opencode.json');
    const toggle = await request(CONTROL_PORT, 'POST', '/toggle', {
      token: TOKEN,
      body: { enabled: true },
    });
    check('/toggle 返回 200', toggle.status === 200, JSON.stringify(toggle.body));
    check('/toggle 报告注入成功', Boolean(toggle.body && toggle.body.ok));

    let config = safeParse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    check('opencode.json 中存在 provider.workbuddy', Boolean(config.provider && config.provider.workbuddy));
    const wb = (config.provider || {}).workbuddy || {};
    check('npm = @ai-sdk/openai-compatible', wb.npm === '@ai-sdk/openai-compatible', wb.npm);
    check(
      `baseURL 指向测试网关 127.0.0.1:${GATEWAY_PORT}/v1`,
      wb.options && wb.options.baseURL === `http://127.0.0.1:${GATEWAY_PORT}/v1`,
      wb.options && wb.options.baseURL,
    );
    check('apiKey = workbuddy-local', Boolean(wb.options && wb.options.apiKey === 'workbuddy-local'));
    check('models 字典含 gpt-5.5 与上下文限制', Boolean(wb.models && wb.models['gpt-5.5']), JSON.stringify(wb.models));
    check(
      '模型 limit.context 取自远端 maxInputTokens',
      Boolean(wb.models && wb.models['gpt-5.5'].limit.context === 1000000),
      JSON.stringify(wb.models && wb.models['gpt-5.5']),
    );
    check('用户原有 provider.mine 未被破坏', Boolean(config.provider && config.provider.mine));
    check('生成了备份文件', fs.existsSync(`${CONFIG_FILE}.workbuddy-backup`));

    // ── 测试 5：网关 /v1/models 标准 OpenAI 格式 ──
    console.log('\n测试 5：网关面 127.0.0.1  GET /v1/models');
    const gwModels = await request(GATEWAY_PORT, 'GET', '/v1/models');
    check('网关返回 200', gwModels.status === 200);
    check('object === "list"', Boolean(gwModels.body && gwModels.body.object === 'list'));
    check('data 是数组', Array.isArray(gwModels.body && gwModels.body.data));
    check(
      '每项含 id / object=model / owned_by',
      Boolean(
        gwModels.body &&
          gwModels.body.data.every((m) => m.id && m.object === 'model' && m.owned_by === 'workbuddy'),
      ),
      JSON.stringify(gwModels.body && gwModels.body.data),
    );

    // ── 测试 6：SSE 真流式透传（上游用 application/json 头返回 SSE 帧）──
    console.log('\n测试 6：网关面 /v1/chat/completions 真流式 + 嗅探');
    const before = (await request(CONTROL_PORT, 'GET', '/usage', { token: TOKEN })).body.requestCount;
    const sse = await request(GATEWAY_PORT, 'POST', '/v1/chat/completions', {
      body: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: true },
      raw: true,
    });
    check('SSE 请求返回 200', sse.status === 200);
    check(
      '响应被改写为 text/event-stream',
      String(sse.headers['content-type'] || '').includes('text/event-stream'),
      sse.headers['content-type'],
    );
    check('响应体包含两段增量', sse.body.includes('Hel') && sse.body.includes('lo'), sse.body.slice(0, 120));
    check('响应体以 [DONE] 结尾', sse.body.trimEnd().endsWith('[DONE]'), sse.body.slice(-40));

    const usage = (await request(CONTROL_PORT, 'GET', '/usage', { token: TOKEN })).body;
    check('usage.requestCount 已 +1', usage.requestCount === before + 1, `${before} → ${usage.requestCount}`);
    check('usage.inputTokens > 0', usage.inputTokens > 0, String(usage.inputTokens));
    check('usage.outputTokens > 0', usage.outputTokens > 0, String(usage.outputTokens));
    check(
      'usage.modelStats 记录了 gpt-5.5',
      Boolean(usage.modelStats && usage.modelStats['gpt-5.5']),
      JSON.stringify(usage.modelStats),
    );

    // ── 测试 7：持久化 ──
    console.log('\n测试 7：状态持久化');
    const stateFile = path.join(CONFIG_DIR, 'workbuddy-ext-state.json');
    check('状态文件已生成', fs.existsSync(stateFile));
    if (fs.existsSync(stateFile)) {
      const mode = (fs.statSync(stateFile).mode & 0o777).toString(8);
      check(`状态文件权限为 600（实际 ${mode}）`, mode === '600');
      const saved = safeParse(fs.readFileSync(stateFile, 'utf8'));
      check('已保存 credential', Boolean(saved.credential && saved.credential.access_token));
      check('已保存 enabled=true', saved.enabled === true);
      check('已保存 usage', saved.usage && saved.usage.requestCount === usage.requestCount);
    }

    // ── 测试 8：/toggle false 移除配置 ──
    console.log('\n测试 8：POST /toggle {enabled:false} 移除配置');
    await request(CONTROL_PORT, 'POST', '/toggle', { token: TOKEN, body: { enabled: false } });
    config = safeParse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    check('provider.workbuddy 已移除', !config.provider || !config.provider.workbuddy);
    check('用户原有 provider.mine 仍在', Boolean(config.provider && config.provider.mine));

    // ── 测试 9：/usage/reset ──
    console.log('\n测试 9：POST /usage/reset');
    const reset = await request(CONTROL_PORT, 'POST', '/usage/reset', { token: TOKEN });
    check('重置后 requestCount 为 0', reset.body && reset.body.requestCount === 0);
    check('重置后 totalTokens 为 0', reset.body && reset.body.totalTokens === 0);

    // ── 测试 10：重启后恢复 ──
    console.log('\n测试 10：重启服务后从磁盘恢复状态');
    service.kill('SIGTERM');
    await sleep(600);
    const service2 = spawn(process.execPath, [path.join(__dirname, 'service', 'index.js')], {
      env: {
        ...process.env,
        HOME: TMP_HOME,
        OPENCHAMBER_SERVICE_PORT: String(CONTROL_PORT),
        OPENCHAMBER_SERVICE_TOKEN: TOKEN,
        WORKBUDDY_ENDPOINT: `http://127.0.0.1:${MOCK_PORT}`,
        WORKBUDDY_GATEWAY_PORT: String(GATEWAY_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service2.stdout.on('data', (d) => serviceLog.push(String(d)));
    service2.stderr.on('data', (d) => serviceLog.push(String(d)));
    await sleep(1500);
    const status2 = await request(CONTROL_PORT, 'GET', '/status', { token: TOKEN });
    check('重启后仍处于已登录状态（无需重新登录）', Boolean(status2.body && status2.body.loggedIn));
    service2.kill('SIGTERM');
    await sleep(300);
  } catch (error) {
    fail++;
    console.log(`  ❌ 测试执行异常: ${error.message}`);
  } finally {
    mock.close();
    try {
      service.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log('\n服务日志尾部:');
    console.log(serviceLog.join('').split('\n').slice(-25).join('\n'));
  }
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main();