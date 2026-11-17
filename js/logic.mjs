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
