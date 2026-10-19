import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tempData, writeState, sampleState } from './helpers.mjs';
const data = tempData();
const cfg = await import('../coach/config.js');
const chat = await import('../coach/chat.js');
const jobs = await import('../coach/jobs.js');
const store = await import('../coach/chat-store.js');
const { coachRoutes } = await import('../coach/routes.js');

async function bridge(t, handler, capabilities = { chat_contract: 1, chat: true }) {
  jobs.clearUser('alice'); cfg.reset();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only');
    assert.equal(req.headers['x-opengym-profile-id'], 'alice');
    if (req.url === '/v1/gym/capabilities') { res.writeHead(capabilities ? 200 : 404); res.end(JSON.stringify(capabilities || {})); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push(body);
    assert.equal(req.url, '/v1/gym/chat');
    assert.equal(req.headers['x-opengym-coach-mode'], 'chat');
    assert.equal(req.headers['x-opengym-request-id'], body.request_id);
    if (handler) await handler(req, res, body);
    else res.end(JSON.stringify({ chat_contract: 1, conversation_id: body.conversation_id, request_id: body.request_id, message: { role: 'assistant', content: '根据你的记录，今天可以休息。' } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  cfg.save({ enabled: true, provider: 'openclaw', authMode: 'instance', auth: {}, boundUid: {},
    providerOptions: { openclaw: { baseUrl: `http://127.0.0.1:${server.address().port}`, profileUid: 'alice' } }, caps: { perProfileDaily: 30, instanceDaily: 40 } });
  cfg.saveAuth('openclaw', { type: 'apikey', data: cfg.encrypt({ token: 'test-only' }) });
  writeState(data, 'alice', sampleState());
  t.after(() => { jobs.clearUser('alice'); server.closeAllConnections(); server.close(); });
  return calls;
}
const input = text => ({ clientId: randomUUID(), message: text || '今天练什么？', lang: 'zh' });
async function settled() {
  for (let i = 0; i < 200; i++) {
    const s = await chat.status('alice');
    if (!s.messages.some(m => m.state === 'running')) return s;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('chat did not settle');
}
test('chat requires authenticated bound account and explicit full-history consent', async t => {
  const calls = await bridge(t);
  await assert.rejects(chat.status('bob'), e => e.code === 'shared');
  await assert.rejects(chat.send('alice', input()), e => e.code === 'consent');
  await assert.rejects(chat.consent('alice', 99), e => e.code === 'consent');
  const routes = coachRoutes({ readSession: () => null, json: (r, code) => { r.code = code; } });
  for (const key of ['GET /api/coach/chat', 'POST /api/coach/chat/consent', 'POST /api/coach/chat/messages']) {
    const res = {}; await routes[key]({}, res); assert.equal(res.code, 401);
  }
  assert.equal(calls.length, 0);
});
test('one persistent conversation, server-owned routing, retry deduplication and shared spending', async t => {
  const calls = await bridge(t);
  await chat.consent('alice', 1);
  const before = jobs.capState('alice').used;
  const msg = input();
  const first = await chat.send('alice', msg);
  const retry = await chat.send('alice', msg);
  assert.equal(first.message.id, retry.message.id);
  let s = await settled();
  assert.equal(s.messages.length, 1); assert.equal(s.messages[0].state, 'complete');
  assert.equal(s.messages[0].fingerprint, undefined);
  assert.equal(s.messages[0].body, undefined);
  assert.match(s.messages[0].reply, /记录/);
  assert.equal((await chat.send('alice', msg)).message.id, first.message.id);
  assert.equal(jobs.capState('alice').used, before + 1);
  await assert.rejects(chat.send('alice', { ...msg, message: 'changed' }), e => e.code === 'conflict');
  await chat.send('alice', input('那明天呢？')); s = await settled();
  assert.equal(s.messages.length, 2); assert.equal(calls.length, 2);
  assert.equal(calls[0].conversation_id, calls[1].conversation_id);
  assert.notEqual(calls[0].request_id, calls[1].request_id);
  assert.match(calls[0].conversation_id, /^gymchat-/);
  assert.equal(calls[0].model, undefined); assert.equal(calls[0].messages, undefined);
  assert.equal(calls[0].proposal_context, null);
  assert.ok(fs.statSync(path.join(data, 'coach-chat', 'alice.json')).mode & 0o600);
});
test('old bridges and unsupported contracts never receive ordinary messages', async t => {
  const calls = await bridge(t, null, null);
  assert.equal((await chat.status('alice')).supported, false);
  await assert.rejects(chat.consent('alice', 1), e => e.code === 'unavailable');
  await assert.rejects(chat.send('alice', input()), e => e.code === 'unavailable');
  assert.equal(calls.length, 0);
});
test('rejects injected routing/context and oversized messages before spending', async t => {
  const calls = await bridge(t); await chat.consent('alice', 1);
  const before = jobs.capState('alice').used;
  for (const bad of [{ ...input(), model: 'glass' }, { ...input(), proposal_context: {} }, { ...input(), conversation_id: 'foreign' }, input('x'.repeat(8001)), { ...input(), clientId: '../x' }, { ...input(), lang: '../x' }]) {
    await assert.rejects(chat.send('alice', bad), e => e.code === 'invalid');
  }
  assert.equal(jobs.capState('alice').used, before); assert.equal(calls.length, 0);
});
test('a chat and a proposal can coexist, but two distinct chat messages cannot overlap', async t => {
  await bridge(t, async (_req, res) => { await new Promise(r => setTimeout(r, 100)); res.end('{}'); });
  await chat.consent('alice', 1);
  const rec = jobs.readUser('alice');
  fs.writeFileSync(path.join(data, 'coach', 'alice.json'), JSON.stringify({ ...rec, current: { id: 'proposal', state: 'running', startedAt: Date.now() } }));
  await chat.send('alice', input());
  await assert.rejects(chat.send('alice', input()), e => e.code === 'busy');
  assert.equal(jobs.status('alice').job.id, 'proposal');
  await settled();
});
test('current proposal reference distinguishes pending and resolved, including actual choices', async t => {
  const calls = await bridge(t); await chat.consent('alice', 1);
  const pending = { id: 'p1', kind: 'create', bundle: { name: '两天训练', routines: [] } };
  fs.writeFileSync(path.join(data, 'coach', 'alice.json'), JSON.stringify({ ...jobs.readUser('alice'), pending }));
  await chat.send('alice', input('这份建议为什么这样安排？')); await settled();
  assert.equal(calls[0].proposal_context.status, 'pending');
  jobs.resolvePending('alice', { accepted: [], rejected: ['plan'], dismissed: true });
  await chat.send('alice', input('我没有采用那个计划')); await settled();
  assert.equal(calls[1].proposal_context.status, 'resolved');
  assert.equal(JSON.parse(calls[1].proposal_context.summary).decision.dismissed, true);
});
test('shared caps stop new chat runs without charging duplicate checks', async t => {
  const calls = await bridge(t); await chat.consent('alice', 1);
  const msg = input(); await chat.send('alice', msg); await settled();
  cfg.save({ caps: { perProfileDaily: jobs.capState('alice').used, instanceDaily: 0 } });
  await chat.send('alice', msg);
  await assert.rejects(chat.send('alice', input()), e => e.code === 'cap');
  assert.equal(calls.length, 1);
});
test('large proposal summaries retain the decision before clipping plan details', () => {
  const context = store.proposalContext({ id: 'large', kind: 'create', bundle: { summary: '中'.repeat(20000) } }, 'resolved', { dismissed: true });
  assert.equal(Array.from(context.summary).length, 12000);
  assert.match(context.summary, /^\{"decision":\{"dismissed":true\}/);
});
test('bad output cannot display tools or another conversation, and upstream errors are redacted', async t => {
  await bridge(t, (_req, res, body) => res.end(JSON.stringify({ chat_contract: 1, conversation_id: 'foreign', request_id: body.request_id, message: { role: 'assistant', content: 'private secret' } })));
  await chat.consent('alice', 1); await chat.send('alice', input());
  const s = await settled(); assert.equal(s.messages[0].error, 'unusable');
  assert.doesNotMatch(JSON.stringify(s), /private secret|test-only/);
});
test('restart and repeat requests never replay an ambiguous model call', async t => {
  const calls = await bridge(t); await chat.consent('alice', 1);
  const rec = store.readChat('alice');
  store.writeChat('alice', { ...rec, messages: [{ id: 'gymmsg-' + randomUUID(), state: 'running', text: 'interrupted', at: 1 }] });
  assert.equal((await chat.status('alice')).messages[0].error, 'restart');
  assert.equal(store.readChat('alice').messages[0].state, 'failed'); assert.equal(calls.length, 0);
});
test('forget aborts an in-flight call, removes consent and never restores late messages', async t => {
  let reached; const ready = new Promise(r => { reached = r; });
  await bridge(t, async (_req, res) => { reached(); await new Promise(r => setTimeout(r, 100)); if (!res.destroyed) res.end('{}'); });
  await chat.consent('alice', 1); await chat.send('alice', input()); await ready;
  const used = jobs.capState('alice').used;
  jobs.clearUser('alice'); await new Promise(r => setTimeout(r, 150));
  assert.equal(store.readChat('alice'), null); assert.equal(jobs.capState('alice').used, used);
  assert.equal((await chat.status('alice')).consent, false);
});
