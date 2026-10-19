// Opt-in cross-runtime check: real openGym handlers/adapter -> real Python bridge -> fake gateway.
// GYM_BRIDGE_PYTHON=deploy/linux/bridge/.venv/bin/python node api/test/gym-bridge-integration.mjs
// All files and ports are temporary; no production configuration or model is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { tempData, writeState, sampleState } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const data = tempData();
const bridgeData = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-bridge-integration-'));
const python = process.env.GYM_BRIDGE_PYTHON || 'python3';
const child = spawn(python, ['-u', '-c', `
import asyncio, json, os, sys
from aiohttp import web
sys.path.insert(0, os.path.join(os.getcwd(), 'deploy/linux/bridge'))
from gym_bridge import GymBridge
calls = []
async def models(req):
    return web.json_response({'data': []})
async def completion(req):
    body = await req.json()
    assert req.headers['Authorization'] == 'Bearer fake-gateway-token'
    session = req.headers['x-openclaw-session-key']
    calls.append({'session': session, 'body': body})
    if body['model'] == 'openclaw/gym-coach':
        assert session.startswith('agent:gym-coach:opengym:alice:gymchat-')
        text = '这是当前会话的回复。'
    else:
        assert body['model'] == 'openclaw/gym-coach-proposal'
        assert session.startswith('agent:gym-coach-proposal:opengym:')
        text = '{"coach_contract":1,"ok":true}'
    res = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
    await res.prepare(req)
    await res.write(('data: '+json.dumps({'choices':[{'delta':{'content':text},'finish_reason':'stop'}]})+'\\n\\ndata: [DONE]\\n\\n').encode())
    return res
async def observed(req):
    return web.json_response(calls)
async def serve(app):
    runner = web.AppRunner(app, handler_cancellation=True)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    return site._server.sockets[0].getsockname()[1]
async def main():
    up = web.Application()
    up.router.add_get('/v1/models', models)
    up.router.add_post('/v1/chat/completions', completion)
    up.router.add_get('/observed', observed)
    gateway = await serve(up)
    os.environ['OPENCLAW_URL'] = f'http://127.0.0.1:{gateway}'
    port = await serve(GymBridge().build())
    print(json.dumps({'bridge':port,'gateway':gateway}), flush=True)
    await asyncio.Event().wait()
asyncio.run(main())
`], {
  cwd: root,
  env: { ...process.env, GYM_BRIDGE_TOKEN: 'bridge-test-token', OPENCLAW_TOKEN: 'fake-gateway-token',
    GYM_PROFILE_UID: 'alice', GYM_BRIDGE_STATE_DIR: bridgeData, GYM_UPSTREAM_AGENT: 'gym-coach-proposal',
    GYM_ALLOWED_MODEL: 'openclaw/gym-coach', GYM_UPSTREAM_TIMEOUT_S: '10' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let stderr = '';
child.stderr.on('data', d => { stderr += d; });
try {
  const ports = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('bridge start timed out: ' + stderr)), 10000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('bridge exited: ' + stderr)); });
    child.stdout.on('data', d => {
      stdout += d;
      const line = stdout.split('\n').find(s => s.startsWith('{"bridge":'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
  });
  const cfg = await import('../coach/config.js');
  const jobs = await import('../coach/jobs.js');
  const { coachRoutes } = await import('../coach/routes.js');
  const { default: adapter } = await import('../coach/adapters/openclaw.js');
  cfg.save({ enabled: true, provider: 'openclaw', authMode: 'instance',
    providerOptions: { openclaw: { baseUrl: `http://127.0.0.1:${ports.bridge}`, profileUid: 'alice' } } });
  cfg.saveAuth('openclaw', { type: 'apikey', data: cfg.encrypt({ token: 'bridge-test-token' }) });
  writeState(data, 'alice', sampleState());
  const routes = coachRoutes({ readSession: req => ({ id: req.uid || 'alice' }), readBody: async req => req.body || {},
    json: (res, code, body) => Object.assign(res, { code, body }), requireAdmin: () => false });
  async function call(key, body, uid) {
    const res = {}; await routes[key]({ body, uid }, res); return res;
  }
  async function settled() {
    for (let i = 0; i < 200; i++) {
      const res = await call('GET /api/coach/chat');
      assert.equal(res.code, 200);
      if (!res.body.messages.some(m => m.state === 'running')) return res.body;
      await wait(20);
    }
    throw new Error('message did not finish');
  }
  assert.equal((await call('GET /api/coach/chat', null, 'bob')).code, 409);
  assert.equal((await call('GET /api/coach/chat')).body.supported, true);
  assert.equal((await call('POST /api/coach/chat/consent', { version: 1 })).code, 200);
  const msg = { clientId: randomUUID(), message: '今天怎么训练？', lang: 'zh' };
  assert.equal((await call('POST /api/coach/chat/messages', msg)).code, 202);
  const first = await settled();
  assert.equal(first.messages[0].reply, '这是当前会话的回复。');
  assert.equal((await call('POST /api/coach/chat/messages', msg)).body.message.id, first.messages[0].id);
  // Bridge sees the validated pending plan and then the recorded decision on the next turn.
  fs.writeFileSync(path.join(data, 'coach', 'alice.json'), JSON.stringify({ ...jobs.readUser('alice'),
    pending: { id: 'p1', kind: 'create', bundle: { name: '测试计划', routines: [] } } }));
  await call('POST /api/coach/chat/messages', { ...msg, clientId: randomUUID(), message: '这份建议为什么这样安排？' });
  await settled();
  await call('POST /api/coach/pending/resolve', { dismissed: true });
  await call('POST /api/coach/chat/messages', { ...msg, clientId: randomUUID(), message: '我没有采用它。' });
  const final = await settled();
  assert.equal(final.messages.length, 3);
  const proposal = await adapter.invoke({ cfg: cfg.load(), env: cfg.jobEnv('/tmp', cfg.credentialFor('alice')), prompt: 'Test the proposal contract.' });
  assert.equal(proposal.code, 0); assert.equal(JSON.parse(proposal.text).coach_contract, 1);
  const seen = await (await fetch(`http://127.0.0.1:${ports.gateway}/observed`)).json();
  assert.equal(seen.length, 4); // three ordinary messages + proposal, no duplicate retry
  assert.equal(new Set(seen.slice(0, 3).map(c => c.session)).size, 1);
  assert.notEqual(seen[0].session, seen[3].session);
  assert.match(seen[1].body.messages[0].content, /status=pending/);
  assert.match(seen[2].body.messages[0].content, /status=resolved/);
  assert.match(seen[2].body.messages[0].content, /"dismissed":true/);
  jobs.clearUser('alice');
  console.log('PASS: API handlers -> Python bridge -> SSE gateway; binding, consent, chat, stable session, dedup, proposal reference/decision and isolated proposal.');
} finally {
  if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(bridgeData, { recursive: true, force: true });
}
