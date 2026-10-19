import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tempData, writeState, sampleState } from './helpers.mjs';

const dataDir = tempData();
const store = await import('../coach/config.js');
const { default: adapter } = await import('../coach/adapters/openclaw.js');
const { adapterFor } = await import('../coach/adapters/index.js');
const { coachRoutes } = await import('../coach/routes.js');
const { runPipeline } = await import('../coach/core/pipeline.js');
const jobs = await import('../coach/jobs.js');
const env = { OPENCLAW_COACH_TOKEN: 'test-gym-token' };
const at = (baseUrl = 'http://gym-bridge:18890') => ({
  provider: 'openclaw', providerOptions: { openclaw: { baseUrl, profileUid: 'alice' } }
});
const answer = (text = '{"coach_contract":1,"ok":true}', finish_reason = 'stop') =>
  ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason }] });
const wire = data => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : null });
    return Response.json(data);
  };
  return { calls, fetch };
};
const invoke = (opts = {}) => adapter.invoke({ cfg: at(), env, prompt: 'test prompt', ...opts });
const fresh = (patch = {}) => {
  store.reset();
  store.save({ enabled: true, authMode: 'instance', auth: {}, models: {}, boundUid: {}, ...at(), ...patch });
};
async function route(path, body) {
  const routes = coachRoutes({
    json: (res, status, value) => Object.assign(res, { status, body: value }),
    readBody: async req => req.body || {},
    readSession: () => ({ id: 'alice', admin: true }),
    requireAdmin: () => true
  });
  const res = {};
  await routes[path]({ body }, res);
  return res;
}
async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    cfg: at(`http://127.0.0.1:${server.address().port}`),
    close: () => { server.closeAllConnections(); server.close(); }
  };
}

test('the gym adapter is registered and routes a fresh, authenticated proposal for each attempt', async () => {
  assert.equal(adapterFor('openclaw'), adapter);
  assert.equal(adapter.spawns, false);
  const w = wire(answer());
  const cfg = at('https://gym.example.test/bridge/v1');
  // Older/manual configuration must not smuggle a shared session, agent or credential.
  cfg.providerOptions.openclaw.headers = { 'x-openclaw-session-key': 'agent:glass:shared', authorization: 'wrong' };
  for (let i = 0; i < 2; i++) assert.equal((await invoke({ cfg, fetch: w.fetch, system: 'rules', maxTokens: 2345 })).code, 0);
  const c = w.calls[0];
  assert.equal(c.url, 'https://gym.example.test/bridge/v1/chat/completions');
  assert.equal(c.redirect, 'error');
  assert.equal(c.headers.authorization, 'Bearer test-gym-token');
  assert.equal(c.headers['x-opengym-profile-id'], 'alice');
  assert.equal(c.headers['x-opengym-coach-mode'], 'proposal');
  assert.equal(c.headers['x-opengym-request-id'], c.body.user);
  assert.equal(c.headers['x-openclaw-session-key'], undefined);
  assert.match(c.body.user, /^opengym-[0-9a-f-]{36}$/);
  assert.notEqual(c.body.user, w.calls[1].body.user);
  assert.equal(c.body.model, 'openclaw/gym-coach');
  assert.equal(c.body.stream, false);
  assert.equal(c.body.max_tokens, 2345);
  assert.equal(c.body.response_format, undefined);
  assert.match(c.body.messages[0].content, /rules$/);
  assert.equal(c.body.messages[1].content, 'test prompt');
});

test('missing credentials, binding, endpoint and malformed persona fail before any request', async () => {
  const w = wire(answer());
  for (const opts of [
    { env: {} }, { cfg: { providerOptions: {} } },
    { cfg: { providerOptions: { openclaw: { baseUrl: 'https://example.test' } } } },
    { cfg: at('https://user:password@example.test') }, { model: 'gym-coach' }
  ]) assert.notEqual((await invoke({ ...opts, fetch: w.fetch })).code, 0);
  assert.equal(w.calls.length, 0);
});

test('models are checked through the same token and profile binding', async () => {
  const w = wire({ data: [{ id: 'openclaw/gym-coach' }, { id: 'unrelated-llm' }] });
  const r = await adapter.check(at(), env, { fetch: w.fetch });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['openclaw/gym-coach']);
  assert.equal(w.calls[0].method, 'GET');
  assert.equal(w.calls[0].headers['x-opengym-profile-id'], 'alice');
  assert.equal((await adapter.models(at(), env, { fetch: wire({ data: [] }).fetch })).ok, false);
});

test('HTTP errors are not retried and never echo an upstream token or training data', async () => {
  for (const status of [400, 401, 403, 429, 502, 503]) {
    let calls = 0;
    const r = await invoke({ fetch: async () => {
      calls++;
      return Response.json({ error: 'test-gym-token private training note' }, { status });
    } });
    assert.equal(calls, 1);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `${status} gym bridge rejected the request`);
  }
});

test('truncated, streaming, oversized and tool-call responses cannot become proposals', async () => {
  const responses = [
    Response.json(answer('half a plan', 'length')),
    new Response('data: {"choices":[]}\n\n'),
    new Response('x'.repeat(1024 * 1024 + 1)),
    Response.json({ choices: [{ message: { content: '{}', tool_calls: [{ id: 'x' }] } }] }),
    Response.json({ choices: [] })
  ];
  for (const res of responses) {
    const r = await invoke({ fetch: async () => res });
    assert.equal(r.code, 1);
    assert.equal(r.text, '');
  }
});

test('deadline and user cancellation interrupt a response stalled after headers', async () => {
  const mock = await localServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"choices":');
  });
  try {
    const timed = await invoke({ cfg: mock.cfg, timeoutMs: 80 });
    assert.equal(timed.timedOut, true);
    const ctl = new AbortController();
    const pending = invoke({ cfg: mock.cfg, signal: ctl.signal, timeoutMs: 2000 });
    setTimeout(() => ctl.abort(), 80);
    assert.equal((await pending).timedOut, true);
  } finally { mock.close(); }
});

test('redirects cannot forward bridge credentials to another endpoint', async () => {
  let followed = 0;
  const mock = await localServer((req, res) => {
    if (req.url === '/elsewhere') { followed++; return res.end('{}'); }
    res.writeHead(307, { location: '/elsewhere' }); res.end();
  });
  try {
    assert.equal((await invoke({ cfg: mock.cfg })).code, 1);
    assert.equal(followed, 0);
  } finally { mock.close(); }
});

test('one explicit MCP profile may use the token, and rotating it does not reset the binding', () => {
  fresh();
  store.saveAuth('openclaw', { type: 'apikey', data: store.encrypt({ token: 'test-gym-token' }) });
  assert.equal(store.isConnected(), true);
  assert.equal(store.credentialFor('alice').ok, true);
  assert.equal(store.credentialFor('bob').ok, false);
  assert.equal(store.boundUidFor(), 'alice');
  const jobEnv = store.jobEnv('/tmp/test-gym', store.credentialFor('alice'));
  assert.equal(jobEnv.OPENCLAW_COACH_TOKEN, 'test-gym-token');
  assert.equal(jobEnv.OPENAI_API_KEY, undefined);
  store.saveAuth('openclaw', { type: 'apikey', data: store.encrypt({ token: 'rotated' }) });
  assert.equal(store.boundUidFor(), 'alice');
  assert.equal(store.credentialFor('bob').ok, false);
  store.save({ authMode: 'profile' });
  assert.equal(store.isConnected(), false);
  store.save({ authMode: 'instance', providerOptions: { openclaw: { baseUrl: 'http://gym-bridge' } } });
  assert.equal(store.isConnected(), false);
  assert.equal(store.credentialFor('alice').ok, false);
});

test('admin config persists endpoint, profile and persona together, rejecting routing overrides', async () => {
  fresh({ provider: 'fixture', providerOptions: {} });
  let r = await route('POST /api/admin/coach/config', {
    provider: 'openclaw', baseUrl: 'http://gym-bridge:18890', profileUid: 'alice', model: 'openclaw/gym-coach'
  });
  assert.equal(r.status, 200);
  assert.deepEqual(store.optionsFor(), { baseUrl: 'http://gym-bridge:18890', profileUid: 'alice' });
  for (const body of [{ profileUid: '../bob' }, { model: 'glass' }, { headers: { 'x-openclaw-agent-id': 'glass' } }]) {
    r = await route('POST /api/admin/coach/config', body);
    assert.equal(r.status, 400);
  }
  r = await route('GET /api/admin/coach');
  assert.equal(r.body.profileUid, 'alice');
  assert.equal(r.body.providers.find(p => p.id === 'openclaw').defaultModel, 'openclaw/gym-coach');
  assert.equal(r.body.runtime.ok, false, 'no token is a clear setup failure');
  await route('POST /api/admin/coach/config', { profileUid: '' });
  assert.equal(store.isConnected(), false);
});

test('real proposal validation and the single repair run remain in charge', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return Response.json(answer(calls.length === 1 ? '{"coach_contract":99}' :
      '{"coach_contract":1,"summary":"继续训练。","changes":[]}'));
  };
  const r = await runPipeline({
    adapter, cfg: at(), kind: 'review',
    payload: { plan: { routines: [], week: {} } },
    invokeOpts: { env, fetch }
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].user, calls[1].user);
});

test('the real job runner refuses another profile before contacting the bridge', async () => {
  let calls = 0;
  const mock = await localServer((req, res) => {
    calls++;
    assert.equal(req.headers['x-opengym-profile-id'], 'alice');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(answer('{"coach_contract":1,"summary":"继续训练。","changes":[]}')));
  });
  try {
    fresh(mock.cfg);
    store.saveAuth('openclaw', { type: 'apikey', data: store.encrypt({ token: 'test-gym-token' }) });
    for (const uid of ['alice', 'bob']) writeState(dataDir, uid, sampleState());
    assert.throws(() => jobs.enqueue('bob', { kind: 'review' }), e => e.code === 'shared');
    assert.equal(calls, 0);
    jobs.enqueue('alice', { kind: 'review' });
    for (let i = 0; i < 100 && jobs.status('alice').job; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(jobs.status('alice').last.outcome, 'nochange');
    assert.equal(calls, 1);
  } finally { jobs.clearUser('alice'); jobs.clearUser('bob'); mock.close(); }
});
