#!/usr/bin/env node
/**
 * WorkBuddy 服务测试脚本
 * 用于验证后端服务是否正常工作
 */

const http = require('http');

const PORT = process.env.TEST_PORT || 9999;
const TOKEN = 'test-token-12345';

async function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('🧪 开始测试 WorkBuddy 服务...\n');

  // 测试 1: Health Check
  console.log('1️⃣  测试 /health 端点...');
  try {
    const resp = await makeRequest('GET', '/health');
    if (resp.status === 200 && resp.body === 'OK') {
      console.log('✅ Health check 通过\n');
    } else {
      console.log('❌ Health check 失败:', resp);
    }
  } catch (error) {
    console.log('❌ Health check 失败:', error.message);
    console.log('⚠️  请先启动服务: OPENCHAMBER_SERVICE_PORT=9999 OPENCHAMBER_SERVICE_TOKEN=test-token-12345 node service/index.js\n');
    process.exit(1);
  }

  // 测试 2: Status
  console.log('2️⃣  测试 /status 端点...');
  try {
    const resp = await makeRequest('GET', '/status');
    const data = JSON.parse(resp.body);
    if (resp.status === 200 && typeof data.enabled === 'boolean') {
      console.log('✅ Status 通过');
      console.log('   状态:', data.account ? `${data.account.nickname} (${data.account.uid})` : '未登录');
      if (data.hardened && data.hardened.active) {
        console.log(`   🛡️ 协议加固正常: App ${data.hardened.appVersion} / CLI ${data.hardened.cliVersion} (${data.hardened.source})`);
        console.log(`      加固特性: ${data.hardened.features.join(', ')}`);
      } else {
        console.log('   ⚠️ 未检测到加固元数据');
      }
    } else {
      console.log('❌ Status 失败:', resp);
    }
  } catch (error) {
    console.log('❌ Status 失败:', error.message);
  }

  // 测试 3: Login Start
  console.log('\n3️⃣  测试 /login/start 端点...');
  try {
    const resp = await makeRequest('POST', '/login/start');
    const data = JSON.parse(resp.body);
    if (resp.status === 200 && data.loginUrl) {
      console.log('✅ Login start 通过');
      console.log('   登录 URL:', data.loginUrl.substring(0, 80) + '...');
    } else {
      console.log('❌ Login start 失败:', resp);
    }
  } catch (error) {
    console.log('❌ Login start 失败:', error.message);
  }

  // 测试 4: Models
  console.log('\n4️⃣  测试 /models 端点...');
  try {
    const resp = await makeRequest('POST', '/models', { force: false });
    const data = JSON.parse(resp.body);
    const modelsArr = Array.isArray(data) ? data : (data && data.models ? data.models : []);
    console.log('✅ Models 通过');
    console.log(`   模型数量: ${modelsArr.length}`);
    if (modelsArr.length > 0) {
      console.log('   示例模型:', modelsArr[0].name || modelsArr[0].id);
    }
  } catch (error) {
    console.log('❌ Models 失败:', error.message);
  }

  // 测试 5: Accounts Pool
  console.log('\n5️⃣  测试 /accounts 账号池端点...');
  try {
    const resp = await makeRequest('GET', '/accounts');
    const data = JSON.parse(resp.body);
    if (resp.status === 200 && Array.isArray(data.accounts)) {
      console.log('✅ Accounts 账号池端点通过');
      console.log(`   账号数量: ${data.totalCount || data.accounts.length}`);
      console.log(`   当前活跃: ${data.activeAccountId || '无'}`);
      if (data.accounts.length > 0) {
        console.log(`   首个账号: ${data.accounts[0].nickname} (${data.accounts[0].region})`);
      }
    } else {
      console.log('❌ Accounts 失败:', resp);
    }
  } catch (error) {
    console.log('❌ Accounts 失败:', error.message);
  }

  // 测试 6: Usage Snapshot (Current vs Global Cumulative)
  console.log('\n6️⃣  测试 /usage 用量统计 (当前 vs 全局累计)...');
  try {
    const resp = await makeRequest('GET', '/usage');
    const data = JSON.parse(resp.body);
    if (resp.status === 200 && data.globalCumulative && data.allAccountsAggregate) {
      console.log('✅ Usage 用量统计通过 (支持当前账号 + 全局累计汇总)');
      console.log(`   当前账号 Token: ${data.currentAccount?.totalTokens || data.totalTokens} (入: ${data.currentAccount?.inputTokens || data.inputTokens} / 出: ${data.currentAccount?.outputTokens || data.outputTokens})`);
      console.log(`   全局累计 Token: ${data.globalCumulative.totalTokens} (入: ${data.globalCumulative.inputTokens} / 出: ${data.globalCumulative.outputTokens})`);
      console.log(`   全账号累计求和: ${data.allAccountsAggregate.totalTokens} Token (跨 ${data.allAccountsAggregate.accountsCount} 个账号)`);
    } else {
      console.log('❌ Usage 失败:', resp);
    }
  } catch (error) {
    console.log('❌ Usage 失败:', error.message);
  }

  console.log('\n🎉 测试完成！');
}

runTests().catch(console.error);
