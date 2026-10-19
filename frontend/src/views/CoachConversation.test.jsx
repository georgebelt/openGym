// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ api: vi.fn(), nav: vi.fn(), toast: vi.fn(), refresh: vi.fn(), review: vi.fn(), refine: vi.fn(), uid: 'alice', state: null, chat: null, job: null }))
vi.mock('../store/useStore.js', () => {
  const snapshot = () => ({ S: m.state, user: { id: m.uid }, ready: true, config: { coach: { enabled: true, provider: 'openclaw' } }, sync: { server: 'https://gym.test' }, update: fn => fn(m.state), pushState: async () => {} })
  const useStore = fn => fn(snapshot()); useStore.getState = snapshot; return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snapshot = () => ({ toast: m.toast, openSheet: vi.fn() }); const useUI = fn => fn(snapshot()); useUI.getState = snapshot; return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => m.nav }))
vi.mock('../lib/api.js', () => ({ api: (...args) => m.api(...args), IS_APPLE: false, IS_ANDROID: false }))
vi.mock('../lib/coach-api.js', () => ({
  useCoachStatus: () => ({ pending: null, job: m.job, loading: false, refresh: m.refresh, maxMessageLen: 1000 }),
  requestReview: (...args) => m.review(...args), refinePlan: (...args) => m.refine(...args),
  requestPlan: vi.fn(), requestDebrief: vi.fn(), resolvePending: vi.fn(), cohortStats: vi.fn(), setCohortShare: vi.fn(),
  jobErrorText: code => 'error: ' + code, awaitedJob: () => null, settleAwaited: vi.fn(), JOB_ERRORS: {}
}))
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))
import CoachChat from './CoachChat.jsx'
let root, el
const render = async () => { await act(async () => { root.render(<CoachChat />) }) }
const button = text => [...el.querySelectorAll('button')].find(b => b.textContent === text)
const click = async b => { expect(b).toBeTruthy(); await act(async () => b.click()) }
const type = async (value, textarea = el.querySelector('.composer textarea')) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, value); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); m.uid = 'alice'; m.job = null
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  m.state = { routines: [{ id: 'r1', name: 'A', ex: [] }], workouts: [], week: {}, customEx: [], coach: { consent: { agreedAt: 'yes', version: 2 }, profile: { goal: 'muscle' }, chat: [], log: [] } }
  m.chat = { supported: true, consent: true, messages: [], maxMessageLen: 1000 }
  m.api.mockImplementation(async (path, opts) => {
    if (path === '/api/coach/chat') return structuredClone(m.chat)
    if (path.endsWith('/consent')) { m.chat.consent = true; return {} }
    if (path.endsWith('/messages')) {
      const body = JSON.parse(opts.body)
      m.chat.messages = [{ id: 'server-msg', clientId: body.clientId, text: body.message, state: 'complete', reply: 'Rest today.', at: 1, finishedAt: 2 }]
      return { message: m.chat.messages[0] }
    }
  })
  el = document.createElement('div'); document.body.append(el); root = createRoot(el)
})
afterEach(async () => { await act(async () => root.unmount()); el.remove(); localStorage.clear(); sessionStorage.clear() })
it('ordinary messages go to chat, never the plan pipeline, with no persona switch', async () => {
  await render(); await type('Should I rest?'); await click(el.querySelector('.send'))
  expect(el.textContent).toContain('Rest today.')
  expect(m.review).not.toHaveBeenCalled(); expect(m.refine).not.toHaveBeenCalled()
  expect(el.textContent).not.toMatch(/persona|gym-coach-proposal|switch mode/i)
})
it('new users can consent and chat without a plan questionnaire', async () => {
  m.chat.consent = false; m.state.coach = {}; await render()
  expect(el.textContent).toContain('full synced training history'); expect(m.nav).not.toHaveBeenCalled()
  await click(button('I understand, let’s go'))
  expect(el.querySelector('.composer textarea')).toBeTruthy(); expect(m.state.coach.profile).toBeUndefined(); expect(m.nav).not.toHaveBeenCalled()
})
it('proposal generation does not disable ordinary chat', async () => {
  m.job = { id: 'plan1', kind: 'create', startedAt: 1 }; await render()
  expect(el.querySelector('.composer textarea').disabled).toBe(false)
  await type('Why three days?'); await click(el.querySelector('.send'))
  expect(m.api.mock.calls.some(([path]) => path.endsWith('/messages'))).toBe(true); expect(m.review).not.toHaveBeenCalled()
})
it('plan submission requires the editable brief and sends only its confirmed text', async () => {
  m.chat.messages = [{ id: 'c1', text: 'Two days please.', reply: 'Sure.', state: 'complete', at: 1, finishedAt: 2 }]
  await render(); await click(button('Generate plan suggestions')); expect(m.review).not.toHaveBeenCalled()
  await type('Two days, 45 minutes.', el.querySelector('.chat-brief textarea')); await click(el.querySelector('.chat-brief button'))
  expect(m.review).toHaveBeenCalledExactlyOnceWith('Two days, 45 minutes.')
  expect(m.state.coach.chat.at(-1).text).toContain('Two days, 45 minutes.')
})
it('uncertain delivery retries the same client ID across remount', async () => {
  const normal = m.api.getMockImplementation(); let sends = 0
  m.api.mockImplementation(async (path, opts) => { if (path.endsWith('/messages') && sends++ === 0) throw new Error('offline'); return normal(path, opts) })
  await render(); await type('Check my recovery'); await click(el.querySelector('.send'))
  expect(el.textContent).toContain('Delivery is not confirmed')
  const first = JSON.parse(m.api.mock.calls.find(([p]) => p.endsWith('/messages'))[1].body)
  await act(async () => root.unmount()); root = createRoot(el); await render(); await click(button('Try again'))
  const requests = m.api.mock.calls.filter(([p]) => p.endsWith('/messages')).map(([, o]) => JSON.parse(o.body))
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(first); expect(el.textContent).toContain('Rest today.')
})
it('an old bridge cannot turn typed conversation into a plan request', async () => {
  m.chat.supported = false; await render()
  expect(el.textContent).toContain('Conversation is temporarily unavailable'); expect(el.querySelector('.composer textarea').disabled).toBe(true)
  expect(m.review).not.toHaveBeenCalled(); expect(m.refine).not.toHaveBeenCalled()
})
it('account changes remove previous messages and ignore late replies', async () => {
  let release; m.api.mockImplementationOnce(() => new Promise(r => { release = r }))
  await render(); m.uid = 'bob'; await render()
  await act(async () => release({ supported: true, consent: true, messages: [{ id: 'secret', text: 'Alice private message', state: 'complete', reply: 'private' }] }))
  expect(el.textContent).not.toContain('Alice private message')
})
it('a plan brief survives the trip to fill missing plan details', async () => {
  delete m.state.coach.profile
  await render(); await click(button('Generate plan suggestions')); await type('Keep this requirement.', el.querySelector('.chat-brief textarea'))
  await click(button('Edit my answers')); expect(m.nav).toHaveBeenCalledWith('/coach/intake?edit=1')
  await act(async () => root.unmount()); root = createRoot(el); await render()
  expect(el.querySelector('.chat-brief textarea').value).toBe('Keep this requirement.')
})
