'use strict';

const assert = require('assert');
const path = require('path');

// Load service functions or run unit assertions
console.log('🧪 运行协议加固 (Hardening) 专项单元测试...\n');

// 1. 测试从 service/index.js 导出的或内建的加固逻辑
// 我们通过 child_process 引入或读取执行
const servicePath = path.join(__dirname, 'service', 'index.js');
const serviceSource = require('fs').readFileSync(servicePath, 'utf8');

// 提取核心纯函数进行隔离单元测试
const vm = require('vm');
const sandbox = {
  console,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  URL,
  require,
  fs: require('fs'),
  os: require('os'),
  path: require('path'),
  state: {
    models: [
      { id: 'deepseek-v4.1-flash' },
      { id: 'hy4-preview' },
      { id: 'glm-5.3' },
      { id: 'kimi-k2.8-preview' },
      { id: 'gpt-5.5' },
      { id: 'gpt-5' }
    ],
    disabledModels: []
  }
};
const ctx = vm.createContext(sandbox);

// 提取 sanitize 与 detour 相关逻辑
vm.runInContext(`
${serviceSource.match(/function resolveClientVersion\(\)[\s\S]*?\n\}/)[0]}
${serviceSource.match(/const ZERO_WIDTH_SPACE = '[\s\S]*?\nfunction sanitizeMessages\(messages\)[\s\S]*?\n\}/)[0]}
${serviceSource.match(/function bodyDeclaresImage[\s\S]*?\n\}/)[0]}
${serviceSource.match(/const DETOUR_LADDER_ORDER = [\s\S]*?\nfunction getDetourCandidateModels\(requestBody, currentModel\)[\s\S]*?\n\}/)[0]}
`, ctx);

// Test 1: resolveClientVersion
console.log('1️⃣ 测试 resolveClientVersion()...');
const clientVer = ctx.resolveClientVersion();
assert(clientVer && clientVer.appVersion, 'appVersion 必须存在');
assert(clientVer && clientVer.cliVersion, 'cliVersion 必须存在');
console.log(`   ✅ 成功检测到版本: App=${clientVer.appVersion}, CLI=${clientVer.cliVersion}, 来源=${clientVer.source}`);

// Test 2: breakIdentityClauses
console.log('\n2️⃣ 测试 breakIdentityClauses()...');
const rawAgent = 'You are an agent powered by deepseek-ai, interacting with the user through the opencode.';
const broken = ctx.breakIdentityClauses(rawAgent);
assert.notStrictEqual(broken, rawAgent, '特征词必须被插入零宽空格打断');
assert(broken.includes('\u200B'), '必须包含零宽空格 \\u200B');
console.log('   ✅ 角色身份特征成功打断: 包含零宽字符');

const runtimeCtx = 'The runtime context names the opencode implementation checkout at /tmp.';
const brokenCtx = ctx.breakIdentityClauses(runtimeCtx);
assert.notStrictEqual(brokenCtx, runtimeCtx, '运行时上下文短语必须被打断');
assert(brokenCtx.includes('\u200B'), '必须包含零宽空格');
console.log('   ✅ 运行时上下文特征成功打断');

// Test 3: isUnapprovedChannelOpening & sanitizePromptText
console.log('\n3️⃣ 测试 sanitizePromptText()...');
const unapprovedPrompt = 'You are an AI coding assistant created by Anthropic/OpenAI.';
const sanitized = ctx.sanitizePromptText(unapprovedPrompt);
assert(sanitized.startsWith('You are a helpful assistant.\n\n'), '未批准渠道开口必须前置官方合规标头');
console.log('   ✅ 开口中和通过: 前置合规标头');

const approvedPrompt = 'You are a helpful assistant.';
const clean = ctx.sanitizePromptText(approvedPrompt);
assert.strictEqual(clean, approvedPrompt, '合规开口无需重复添加前缀');
console.log('   ✅ 合规开口保持原样');

// Test 4: sanitizeMessages
console.log('\n4️⃣ 测试 sanitizeMessages()...');
const messages = [
  { role: 'system', content: 'You are opencode agent powered by deepseek.' },
  { role: 'user', content: 'You are an AI assistant, please help me.' },
  { role: 'assistant', content: 'You are interacting with the user through the opencode.' }
];
const sanitizedMsgs = ctx.sanitizeMessages(messages);
assert(sanitizedMsgs[0].content.startsWith('You are a helpful assistant.\n\n'), 'system 角色必须被净化');
assert.strictEqual(sanitizedMsgs[1].content, messages[1].content, 'user 角色的文本必须原样保留不能篡改');
assert(sanitizedMsgs[2].content.includes('\u200B'), 'assistant 角色中的身份词必须被零宽空格打断');
console.log('   ✅ 消息流多角色净化通过');

// Test 5: getDetourCandidateModels
console.log('\n5️⃣ 测试 getDetourCandidateModels (6004 迂回阶梯)...');
const textDetours = ctx.getDetourCandidateModels({ messages: [{ role: 'user', content: 'hello' }] }, 'deepseek-v4.1-flash');
assert(textDetours.length > 0, '必须有迂回候选模型');
assert(!textDetours.includes('deepseek-v4.1-flash'), '候选列表不能包含触发 6004 的原模型');
console.log(`   ✅ 文本模型迂回阶梯: ${textDetours.join(' -> ')}`);

ctx.state.models.find(m => m.id === 'gpt-5').supportsImages = true;
const imageDetours = ctx.getDetourCandidateModels({
  messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] }]
}, 'gpt-5.5');
assert(imageDetours.length > 0, '图像模型迂回必须有候选');
assert(!imageDetours.includes('gpt-5.5'), '候选列表不能包含触发 6004 的原模型');
console.log(`   ✅ 多模态图像模型迂回阶梯: ${imageDetours.join(' -> ')}`);

console.log('\n🎉 协议加固 (Hardening) 专项测试全部通过！\n');
