import { randomUUID, createHash } from 'node:crypto';
import * as config from './config.js';
import { bridgeRequest } from './adapters/openclaw.js';
import { fetchFor } from './node-fetch.js';
import { CoachError, chargeRun, capState, status as proposalStatus, TIMEOUT_MS } from './jobs.js';
import { activeChats, readChat, writeChat, proposalContext } from './chat-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const capabilities = new Map();
export const CONSENT_VERSION = 1;
const fail = code => { throw new CoachError(code, code); };
function connection(uid) {
  if (!config.isEnabled() || !config.isConnected() || config.load().provider !== 'openclaw') fail('off');
  const cred = config.credentialFor(uid);
  if (!cred.ok) fail(cred.reason === 'shared-account' ? 'shared' : 'off');
  return { cfg: config.load(), env: config.jobEnv('/tmp', cred) };
}
async function available(uid) {
  const { cfg, env } = connection(uid);
  const key = JSON.stringify([cfg.providerOptions?.openclaw, config.authFor(cfg)]);
  let entry = capabilities.get(key);
  if (!entry || entry.until < Date.now()) {
    capabilities.clear(); // only one bridge is configured at a time
    entry = { until: Date.now() + 30000, promise: bridgeRequest(cfg, env, '/v1/gym/capabilities', null, { timeoutMs: 5000 })
      .then(r => r.ok && r.data?.chat_contract === 1 && r.data?.chat === true) };
    capabilities.set(key, entry);
  }
  return entry.promise;
}
function recovered(uid) {
  const rec = readChat(uid);
  if (rec?.messages.some(m => m.state === 'running') && !activeChats.has(uid)) {
    rec.messages = rec.messages.map(m => m.state === 'running' ? { ...m, state: 'failed', error: 'restart' } : m);
    writeChat(uid, rec); // never replay a possibly completed model call after restart
  }
  return rec;
}
export async function status(uid) {
  const supported = await available(uid);
  const rec = recovered(uid);
  return {
    supported, consent: rec?.consent?.version === CONSENT_VERSION,
    messages: (rec?.messages || []).slice(-40).map(({ fingerprint, body, ...m }) => m),
    cap: capState(uid), maxMessageLen: Math.min(config.load().maxMessageLen || 1000, 8000)
  };
}
export async function consent(uid, version) {
  if (version !== CONSENT_VERSION) fail('consent');
  if (!await available(uid)) fail('unavailable');
  // Recheck after the network wait: configuration/binding might have changed.
  connection(uid);
  const rec = recovered(uid) || { id: 'gymchat-' + randomUUID(), messages: [] };
  writeChat(uid, { ...rec, consent: { version, agreedAt: Date.now() } });
  return status(uid);
}
export async function send(uid, input) {
  connection(uid);
  if (!input || Object.keys(input).some(k => !['clientId', 'message', 'lang'].includes(k))) fail('invalid');
  const { clientId, message, lang = 'en' } = input;
  if (!UUID.test(clientId || '') || typeof message !== 'string' || !message.trim() ||
      Array.from(message).length > Math.min(config.load().maxMessageLen || 1000, 8000) ||
      typeof lang !== 'string' || !/^[a-zA-Z-]{2,16}$/.test(lang)) fail('invalid');
  if (!await available(uid)) fail('unavailable');
  const { cfg, env } = connection(uid);
  const rec = recovered(uid);
  if (rec?.consent?.version !== CONSENT_VERSION) fail('consent');
  const fingerprint = createHash('sha256').update(JSON.stringify([message, lang])).digest('hex');
  const old = rec.messages.find(m => m.clientId === clientId);
  if (old) {
    if (old.fingerprint !== fingerprint) fail('conflict');
    return { message: publicMessage(old) }; // no extra charge, no upstream replay
  }
  if (activeChats.has(uid)) fail('busy');
  chargeRun(uid);
  const id = 'gymmsg-' + randomUUID();
  const body = {
    chat_contract: 1, conversation_id: rec.id, request_id: id, message, lang,
    proposal_context: proposalContext(proposalStatus(uid).pending) || rec.proposalContext || null
  };
  const m = { id, clientId, fingerprint, text: message, at: Date.now(), state: 'running' };
  // Keep 200 IDs for retry deduplication, but only 40 messages in the app's current history.
  rec.messages = [...rec.messages, m].slice(-200);
  writeChat(uid, rec);
  const ctl = new AbortController();
  activeChats.set(uid, ctl);
  void run(uid, rec.id, m, body, cfg, env, ctl);
  return { message: publicMessage(m) };
}
const publicMessage = ({ fingerprint, body, ...m }) => m;
async function run(uid, conversationId, m, body, cfg, env, ctl) {
  let error = 'provider', content = null;
  try {
    const r = await bridgeRequest(cfg, env, '/v1/gym/chat', body, {
      mode: 'chat', timeoutMs: TIMEOUT_MS, fetch: fetchFor(TIMEOUT_MS), signal: ctl.signal
    });
    const d = r.data;
    if (r.timedOut) error = 'timeout';
    else if (r.ok) {
      if (d?.chat_contract === 1 && d.conversation_id === conversationId && d.request_id === m.id &&
          d.message?.role === 'assistant' && typeof d.message.content === 'string' &&
          d.message.content.trim() && Array.from(d.message.content).length <= 32000 &&
          !d.message.tool_calls?.length) content = d.message.content;
      else error = 'unusable';
    }
  } catch { /* public errors never include upstream details */ }
  finally {
    // A forgotten/replaced account must not be resurrected by a late response.
    if (activeChats.get(uid) === ctl) {
      activeChats.delete(uid);
      const rec = readChat(uid);
      if (rec?.id === conversationId) {
        rec.messages = rec.messages.map(x => x.id === m.id
          ? { ...x, state: content ? 'complete' : 'failed', reply: content, error: content ? null : error, finishedAt: Date.now() } : x);
        writeChat(uid, rec);
        config.logJob({ at: Date.now(), kind: 'chat', trigger: 'manual', outcome: content ? 'ready' : 'failed', errorClass: content ? null : error, ms: Date.now() - m.at });
      }
    }
  }
}
