// US & Always — pure, environment-agnostic helpers shared by app.js and
// features.mjs. No DOM, no network: everything here is unit-testable in
// Node (see tests/fix_regressions.mjs).

// ---- Bug #5: voice container sniffing -------------------------------------
// Recordings are sealed as raw bytes with no mime stored on the wire, and
// browsers disagree about which container they record (MP4/AAC vs
// WebM/Opus). Sniff the container from the bytes instead of forcing a
// type: MP4 family starts with an "ftyp" box at offset 4, WebM/Matroska
// with the EBML header 1A 45 DF A3, Ogg with "OggS". Returns '' when
// unknown — a Blob with an empty type lets the browser sniff for itself.
export function sniffAudioType(bytes) {
  if (!bytes || bytes.length < 4) return '';
  if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) return 'audio/webm';
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'audio/mp4';
  if (bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'audio/ogg';
  return '';
}

// ---- Bug #10: Spin the Bottle counter --------------------------------------
// Android initialises its spin counter at -1 and its first spin writes
// n = 0. The web client must start at -1 too, or it ignores that first
// spin. Returns the counter value to adopt: the incoming n when it is a
// number different from the current counter, otherwise the current one.
export function nextSpinCount(current, incoming) {
  return (typeof incoming === 'number' && incoming !== current) ? incoming : current;
}

// ---- Bug #7: Listen/Watch Together shared playback row ----------------------
// playback_state is ONE row per couple shared by music and video. Decide
// what a screen for `kind` may do with the fetched row:
//   'empty' — no row or no URL: show nothing yet
//   'mine'  — the row belongs to this kind: drive the media element
//   'other' — the partner is using the other player: show a notice, do
//             not touch the media element and do not write state
export function playbackDecision(row, kind) {
  if (!row || !row.url) return 'empty';
  return row.kind === kind ? 'mine' : 'other';
}

// ---- Bug #4: Conflict Resolution latest answer per user ---------------------
// conflict_answers has no unique constraint, so several rows per
// (question, user) can exist. Given rows ordered newest-first OR in any
// order, pick the row with the highest id per user.
export function latestRowPerUser(rows, myId) {
  let mine = null, theirs = null;
  for (const r of rows || []) {
    if (r.user_id === myId) { if (!mine || r.id > mine.id) mine = r; }
    else if (!theirs || r.id > theirs.id) theirs = r;
  }
  return { mine, theirs };
}

// ---- Realtime + unread badge upgrade (2026-11-18) ---------------------------

// Tiny FNV-1a 32-bit hash (hex) — a cheap fingerprint for long strings.
export function fnv1aHex(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Signature of everything that determines a message row's DECRYPTED
// content: the row id, its type and its sealed bytes. read_at / edited
// are deliberately excluded — they never change the plaintext (an edit
// always arrives with fresh ciphertext), so a read receipt must not
// force a re-decrypt of the whole history on every poll.
export function rowDecryptSignature(row) {
  if (!row) return '';
  const ct = String(row.ciphertext ?? '');
  const nn = String(row.nonce ?? '');
  return [row.id, row.type || '', ct.length, fnv1aHex(ct), fnv1aHex(nn)].join(':');
}

// PostgREST count responses carry the total in the Content-Range
// header: "0-9/42" for a ranged GET, "*/42" for a HEAD count. Returns
// the total, or null when the header is missing or the total is not a
// plain number (e.g. "*").
export function parseContentRangeTotal(header) {
  if (!header || typeof header !== 'string') return null;
  const slash = header.lastIndexOf('/');
  if (slash < 0) return null;
  const total = header.slice(slash + 1).trim();
  if (!/^\d+$/.test(total)) return null;
  return parseInt(total, 10);
}

// What the Chat tab badge shows for an unread count: hidden at 0, the
// number itself up to 99, then "99+".
export function badgeLabel(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return '';
  return n > 99 ? '99+' : String(n);
}

// Reconnect backoff for the realtime socket: 1s, 2s, 4s, 8s … capped
// at 30s so a dead network never spins the radio.
export function nextReconnectDelay(attempt) {
  const a = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(1000 * 2 ** a, 30000);
}

// What to do when a realtime event for the messages table arrives:
//   'reload' — the chat screen is open: re-run its load (diff-rendered
//              and decrypt-cached, so this is cheap).
//   'notify' — a partner message landed while another screen is open:
//              refresh the badge and use the usual new-message notice.
//   'badge'  — a partner change that can only move the count (an edit
//              or a read receipt while another screen is open).
//   'ignore' — my own change while another screen is open: my own
//              messages never count as unread.
export function realtimeMessageAction({ screen, eventType, senderId, myId }) {
  if (screen === 'chat') return 'reload';
  const fromPartner = !!senderId && !!myId && senderId !== myId;
  if (!fromPartner) return 'ignore';
  return eventType === 'INSERT' ? 'notify' : 'badge';
}

// ---- Bug #3: chat render signature ------------------------------------------
// A stable string describing everything renderMessages() paints. The
// chat poll compares signatures and skips the DOM rebuild when nothing
// visible changed (protects playing audio, scroll position, photos).
export function chatSignature(messages) {
  return (messages || []).map((m) => [
    m.serverId,
    m.edited ? 1 : 0,
    m.readAt ? 1 : 0,
    m.revealed ? 1 : 0,
    (m.reactions || []).map((r) => r.user_id + '=' + r.emoji).sort().join('+'),
  ].join(':')).join('|');
}
