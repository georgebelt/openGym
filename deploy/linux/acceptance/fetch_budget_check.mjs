/* L1 传输验收:验收脚本与生产同款 fetchFor 的长任务行为(docs/OPENCLAW_COLLABORATION.md)。
 *
 * 用独立端口(18899,非生产 bridge 18890)的假上游验证传输层,不消耗真实模型:
 *   A. 响应头延迟 310s(> Node 全局 fetch 的 ~300s undici 头超时、< 业务预算)→ 必须正常完成;
 *   B. 延迟超过业务预算 → adapter 报 timeout,且假上游观察到连接被关闭(终止);
 *   C. 主动 AbortController 取消 → 立即终止,假上游观察到连接被关闭。
 *
 * 运行:node fetch_budget_check.mjs            (全程 ~6 分钟,A 占大头)
 *       FAST=1 node fetch_budget_check.mjs    (A 用 8s 延迟 + 5s 全局fetch对照,快速冒烟)
 */
import http from 'node:http';

const { default: adapter } = await import('../../../api/coach/adapters/openclaw.js');
const { fetchFor } = await import('../../../api/coach/node-fetch.js');

const PORT = 18899;
const FAST = !!process.env.FAST;
const DELAY_A_MS = FAST ? 8000 : 310000;      // A:>300s(FAST 模式仅冒烟流程)
const BUDGET_A_MS = FAST ? 60000 : 480000;    // 与部署 COACH_JOB_TIMEOUT_MS 一致
const BUDGET_B_MS = 60000;                    // B:预算 60s(fetchFor 下限),延迟 75s
const DELAY_B_MS = 75000;

const seen = [];                              // 假上游视角:{id, closedBeforeReply}
const srv = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) { res.end('{"object":"list","data":[]}'); return; }
  const rec = { closedBeforeReply: false };
  seen.push(rec);
  const delay = +req.headers['x-fake-delay-ms'] || 0;
  req.resume();
  const timer = setTimeout(() => {
    rec.replied = true;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{
      index: 0, message: { role: 'assistant', content: '{"coach_contract":1,"ok":true}' },
      finish_reason: 'stop' }] }));
  }, delay);
  res.on('close', () => { if (!rec.replied) { rec.closedBeforeReply = true; clearTimeout(timer); } });
});
await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

const cfg = { providerOptions: { openclaw: { baseUrl: `http://127.0.0.1:${PORT}`, profileUid: 'x' } } };
const env = { OPENCLAW_COACH_TOKEN: 'fake-for-transport-check' };

async function invoke({ delayMs, timeoutMs, fetch, signal, label }) {
  const t0 = Date.now();
  const r = await adapter.invoke({
    cfg, prompt: 'p', system: 's', model: 'openclaw/gym-coach', timeoutMs,
    env, fetch: (url, init = {}) => fetch(url, { ...init,
      headers: { ...(init.headers || {}), 'x-fake-delay-ms': String(delayMs) } }),
    signal, maxTokens: 100
  }).catch(e => ({ code: 1, text: '', err: String(e).slice(0, 120) }));
  const ms = Date.now() - t0;
  const out = { label, ms, code: r.code, timedOut: !!r.timedOut, text: (r.text || '').slice(0, 40) };
  console.log(JSON.stringify(out));
  return out;
}

const results = {};

// A. 延迟 > 300s,预算内 → 必须成功(生产同款 fetchFor)
results.longWaitOk = await invoke({ delayMs: DELAY_A_MS, timeoutMs: BUDGET_A_MS,
  fetch: fetchFor(BUDGET_A_MS), label: `A fetchFor 延迟${DELAY_A_MS / 1000}s` });

// A'(对照,仅 FAST):全局 fetch 在同样延迟下的行为差异说明问题根源
if (FAST) {
  results.globalFetchControl = await invoke({ delayMs: 8000, timeoutMs: 60000,
    fetch: globalThis.fetch, label: "A' 全局fetch 对照(FAST)" });
}

// B. 延迟 > 预算 → timeout,且上游连接被关闭
const before = seen.length;
results.budgetKills = await invoke({ delayMs: DELAY_B_MS, timeoutMs: BUDGET_B_MS,
  fetch: fetchFor(BUDGET_B_MS), label: 'B 预算耗尽' });
await new Promise(r => setTimeout(r, 500));
results.budgetUpstreamClosed = seen[before]?.closedBeforeReply === true;

// C. 主动取消 → 立即终止,上游连接被关闭
const ctl = new AbortController();
setTimeout(() => ctl.abort(), 3000);
const beforeC = seen.length;
results.cancel = await invoke({ delayMs: 120000, timeoutMs: 480000,
  fetch: fetchFor(480000), signal: ctl.signal, label: 'C 主动取消@3s' });
await new Promise(r => setTimeout(r, 500));
results.cancelUpstreamClosed = seen[beforeC]?.closedBeforeReply === true;

srv.close();

const pass = results.longWaitOk.code === 0 && results.longWaitOk.text.includes('coach_contract')
  && results.budgetKills.code !== 0 && results.budgetUpstreamClosed
  && results.cancel.code !== 0 && results.cancel.ms < 10000 && results.cancelUpstreamClosed;
console.log('\n结论:', pass ? 'PASS' : 'FAIL', JSON.stringify({
  A_ok: results.longWaitOk.code === 0, A_ms: results.longWaitOk.ms,
  B_timeout: results.budgetKills.code !== 0, B_upstream_closed: results.budgetUpstreamClosed,
  C_cancel_ms: results.cancel.ms, C_upstream_closed: results.cancelUpstreamClosed
}));
process.exit(pass ? 0 : 1);
