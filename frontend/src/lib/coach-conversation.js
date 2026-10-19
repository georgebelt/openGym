import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { getLang } from './i18n.js'

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
const read = key => { try { return JSON.parse(localStorage.getItem(key)) } catch { return null } }
const save = (key, value) => { try { value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key) } catch { /* private storage unavailable */ } }

export function usePlanBrief(scope) {
  const key = 'gym_coach_brief:' + scope
  const [brief, setBrief] = useState(() => { try { return sessionStorage.getItem(key) } catch { return null } })
  return [brief, value => {
    try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value) } catch { /* unavailable */ }
    setBrief(value)
  }]
}

// The caller keys the screen by server/account. Nothing from one account survives in another
// screen; an uncertain send keeps its client ID across navigation and connection loss.
export function useConversation(active, scope) {
  const key = 'gym_coach_outbox:' + scope
  const [state, setState] = useState({ loading: active, supported: false, messages: [] })
  const [outbox, setOutbox] = useState(() => active ? read(key) : null)
  const [sending, setSending] = useState(false)
  const live = useRef(true)
  const seq = useRef(0)
  const timer = useRef(null)
  const tick = useRef(null)
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const next = await api('/api/coach/chat')
      if (!live.current || mine !== seq.current) return next
      setState(prev => ({ ...next, supported: prev.supported || next.supported, available: next.supported, loading: false }))
      const queued = read(key)
      if (queued && (!next.consent || next.messages?.some(m => m.clientId === queued.clientId))) { save(key, null); setOutbox(null) }
      if (next.messages?.some(m => m.state === 'running') && tick.current) {
        clearTimeout(timer.current); timer.current = setTimeout(tick.current, 3000)
      }
      return next
    } catch {
      if (live.current && mine === seq.current) setState(prev => ({ ...prev, loading: false, available: false }))
      return null
    }
  }, [key])
  useEffect(() => {
    live.current = true
    if (!active) return
    const poll = async () => {
      const next = await refresh()
      if (!live.current) return
      clearTimeout(timer.current)
      timer.current = setTimeout(poll, next?.messages?.some(m => m.state === 'running') ? 3000 : 15000)
    }
    tick.current = poll
    poll()
    return () => { live.current = false; ++seq.current; tick.current = null; clearTimeout(timer.current) }
  }, [active, refresh])
  const send = async (text, retry = null) => {
    if (sending) return
    const body = retry || { clientId: crypto.randomUUID(), message: text.trim(), lang: getLang() }
    save(key, body)
    setOutbox(body)
    setSending(true)
    try {
      await post('/api/coach/chat/messages', body)
      save(key, null)
      if (live.current) setOutbox(null)
      await refresh()
    } catch (e) {
      // Explicit pre-queue refusals are safe to edit; an ambiguous connection failure keeps
      // the original ID. Otherwise a typo/changed length limit could strand the composer.
      if (e.status === 401 || ['invalid', 'consent', 'busy', 'conflict', 'cap', 'shared', 'off', 'unavailable'].includes(e.data?.code)) {
        save(key, null)
        if (live.current) setOutbox(null)
      }
      throw e
    } finally { if (live.current) setSending(false) }
  }
  const agree = async () => { await post('/api/coach/chat/consent', { version: 1 }); await refresh() }
  return { ...state, outbox, sending, send, agree, refresh }
}
