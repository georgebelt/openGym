/* The restricted gym bridge, not the general-purpose OpenClaw gateway.
 * See docs/OPENCLAW_GYM_COACH_REQUIREMENTS.md for the other end of this protocol.
 * The bridge owns persona routing, fresh sessions and tool isolation; the existing
 * pipeline still validates every proposal before the user can apply it.
 */
import { randomUUID } from 'node:crypto';
import { baseUrlFor, validateBaseUrl } from '../core/providers.js';
import { endpointUrl, MAX_OUTPUT_TOKENS } from '../core/adapters/http.js';
import { SYSTEM_PROMPT } from '../core/system-prompt.js';
import { OPENCLAW_PROVIDER, validCoachProfile, validCoachPersona } from '../openclaw-provider.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const optionsFor = cfg => cfg?.providerOptions?.openclaw || {};
function configurationError(cfg, env) {
  const base = baseUrlFor('openclaw', cfg);
  if (!base || !validateBaseUrl(base).ok) return 'configure the gym bridge endpoint';
  if (!validCoachProfile(optionsFor(cfg).profileUid)) return 'configure the MCP profile ID';
  if (!env?.OPENCLAW_COACH_TOKEN) return 'no gym bridge token configured';
  return null;
}

// Keep the deadline and cancellation attached until the BODY has arrived. The bridge may
// send headers immediately, then spend minutes waiting for the persona's final answer.
export async function bridgeRequest(cfg, env, path, body, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 20000, signal, mode = 'proposal' } = {}) {
  const error = configurationError(cfg, env);
  if (error) return { ok: false, error };
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) ctl.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const res = await fetchImpl(endpointUrl(baseUrlFor('openclaw', cfg), path), {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: ctl.signal,
      headers: {
        authorization: 'Bearer ' + env.OPENCLAW_COACH_TOKEN,
        'x-opengym-profile-id': optionsFor(cfg).profileUid,
        ...(body ? {
          'content-type': 'application/json',
          'x-opengym-request-id': mode === 'chat' ? body.request_id : body.user,
          'x-opengym-coach-mode': mode
        } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!res.ok) {
      await res.body?.cancel();
      // An upstream exception can contain credentials or the user's prompt. Never echo it.
      return { ok: false, error: `${res.status} gym bridge rejected the request` };
    }
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, error: 'gym bridge returned an empty response' };
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { ok: false, error: 'gym bridge response exceeds 1 MiB' };
      }
      chunks.push(Buffer.from(value));
    }
    try { return { ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
    catch { return { ok: false, error: 'gym bridge must return a JSON response (not an SSE stream)' }; }
  } catch {
    return ctl.signal.aborted
      ? { ok: false, error: 'gym bridge request timed out or was cancelled', timedOut: true }
      : { ok: false, error: 'could not reach the gym bridge; check its address and network connection' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

const adapter = {
  id: 'openclaw', runtime: OPENCLAW_PROVIDER.runtime, spawns: false, needsRuntime: false,
  baseUrl: cfg => baseUrlFor('openclaw', cfg),
  async models(cfg, env, opts) {
    const r = await bridgeRequest(cfg, env, '/v1/models', null, opts);
    if (!r.ok) return { ...r, models: [] };
    const models = Array.isArray(r.data?.data)
      ? r.data.data.map(m => m?.id).filter(validCoachPersona) : [];
    if (!models.length) return { ok: false, error: 'gym bridge returned no OpenClaw personas', models: [] };
    return { ok: true, models: [...new Set(models)].sort() };
  },
  async check(cfg, env, opts) {
    const r = await adapter.models(cfg, env, opts);
    return r.ok ? { ...r, version: `Gym bridge · ${r.models.join(', ')}` } : r;
  },
  async invoke({ cfg, env, model = OPENCLAW_PROVIDER.defaultModel, prompt, system,
    maxTokens = MAX_OUTPUT_TOKENS, timeoutMs = 5 * 60000, ...opts } = {}) {
    const error = configurationError(cfg, env);
    if (error) return { code: -1, text: '', stderr: error, spawnError: true };
    const chosen = model || OPENCLAW_PROVIDER.defaultModel;
    if (!validCoachPersona(chosen)) return { code: 1, text: '', stderr: 'persona must be openclaw/<agent-id>' };
    const r = await bridgeRequest(cfg, env, '/v1/chat/completions', {
      model: chosen, stream: false,
      // A fresh ID for every pipeline attempt, including a repair. No persistent conversation
      // or static session header can accidentally mix workouts, profiles or prior answers.
      user: 'opengym-' + randomUUID(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + (system ? '\n\n' + system : '') },
        { role: 'user', content: prompt }
      ],
      max_tokens: maxTokens
    }, { ...opts, timeoutMs });
    // No automatic retry: an agent may already have run despite a timeout or a 502.
    if (!r.ok) return { code: 1, text: '', stderr: r.error, timedOut: !!r.timedOut };
    const choice = r.data?.choices?.[0];
    if (choice?.finish_reason === 'length') return { code: 1, text: '', stderr: 'the answer was cut off at the output limit' };
    const text = choice?.message?.content;
    if (typeof text !== 'string' || !text.trim() || choice.message.tool_calls?.length) {
      return { code: 1, text: '', stderr: 'gym bridge must return the final answer as message.content' };
    }
    return { code: 0, text, stderr: '' };
  }
};
export default adapter;
