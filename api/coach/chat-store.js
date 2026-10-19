// Server-owned conversation records never compete with a device's whole-state sync.
import fs from 'node:fs';
import path from 'node:path';
import { validCoachProfile } from './openclaw-provider.js';

const dir = path.join(process.env.DATA_DIR || '/data', 'coach-chat');
export const activeChats = new Map();
const fileFor = uid => {
  if (!validCoachProfile(uid)) throw new Error('invalid profile');
  return path.join(dir, uid + '.json');
};
export function readChat(uid) {
  try { return JSON.parse(fs.readFileSync(fileFor(uid), 'utf8')); }
  catch { return null; }
}
export function writeChat(uid, record) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileFor(uid);
  fs.writeFileSync(file + '.tmp', JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
export function clearChat(uid) {
  activeChats.get(uid)?.abort();
  activeChats.delete(uid);
  try { fs.unlinkSync(fileFor(uid)); } catch { /* no conversation */ }
}
export function proposalContext(p, status = 'pending', decision = null) {
  if (!p) return null;
  return {
    id: String(p.id).slice(0, 80), kind: p.kind, status,
    summary: Array.from(JSON.stringify({
      // The bounded summary must keep the user's choice even when a large plan is clipped.
      decision, proposal: p.bundle || p.proposal || p
    })).slice(0, 12000).join('')
  };
}
export function rememberDecision(uid, pending, decision) {
  const rec = readChat(uid);
  if (rec) writeChat(uid, { ...rec, proposalContext: proposalContext(pending, 'resolved', decision) });
}
