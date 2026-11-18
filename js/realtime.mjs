// US & Always — hand-written Supabase Realtime client: the Phoenix
// channel protocol over a raw WebSocket. No supabase-js — the app is
// build-free and dependency-free, so the small slice of the protocol
// we need is implemented here directly: join one channel, subscribe
// to postgres_changes on public.messages for our couple, heartbeat,
// push access-token refreshes, reconnect with backoff.
//
// Everything is defensive: if WebSocket is unavailable or the join is
// refused (for example because the table is not in the realtime
// publication), the client simply stays disconnected and the app's
// existing polling remains fully in charge.

import { SUPABASE_URL, ANON_KEY, accessToken } from './api.mjs';
import { nextReconnectDelay } from './logic.mjs';

const HEARTBEAT_MS = 25000;
const TOKEN_CHECK_MS = 30000;
const TOPIC = 'realtime:ua-messages';

export function createRealtimeClient({ onEvent, onStatus } = {}) {
  let ws = null;
  let coupleId = '';
  let joinRef = null;
  let refSeq = 0;
  let joined = false;
  let stopped = true; // until setCouple() asks for a connection
  let attempt = 0;
  let heartbeatTimer = null;
  let tokenTimer = null;
  let reconnectTimer = null;
  let lastToken = '';

  const nextRef = () => String(++refSeq);
  const emitStatus = () => { try { if (onStatus) onStatus(joined); } catch { /* listener errors must not kill the socket */ } };

  function wsUrl() {
    const base = SUPABASE_URL.replace(/^http/, 'ws'); // https -> wss, http -> ws
    return base + '/realtime/v1/websocket?apikey=' + encodeURIComponent(ANON_KEY) + '&vsn=1.0.0';
  }

  function send(topic, event, payload, ref, jr) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({
        topic, event, payload: payload || {},
        ref: ref !== undefined ? ref : nextRef(),
        join_ref: jr !== undefined ? jr : joinRef,
      }));
      return true;
    } catch { return false; }
  }

  function startTimers() {
    stopTimers();
    heartbeatTimer = setInterval(() => { send('phoenix', 'heartbeat', {}, nextRef(), null); }, HEARTBEAT_MS);
    // The access token in the join only lives as long as the JWT does.
    // REST traffic keeps the stored session fresh; forward any new
    // token to the channel so RLS keeps applying to this socket.
    tokenTimer = setInterval(() => {
      const t = accessToken();
      if (t && t !== lastToken && joined) {
        lastToken = t;
        send(TOPIC, 'access_token', { access_token: t });
      }
    }, TOKEN_CHECK_MS);
  }
  function stopTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (tokenTimer) clearInterval(tokenTimer);
    heartbeatTimer = tokenTimer = null;
  }

  function join() {
    const ref = nextRef();
    joinRef = ref;
    lastToken = accessToken();
    const payload = {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: '' },
        postgres_changes: [
          { event: 'INSERT', schema: 'public', table: 'messages', filter: 'couple_id=eq.' + coupleId },
          { event: 'UPDATE', schema: 'public', table: 'messages', filter: 'couple_id=eq.' + coupleId },
        ],
      },
    };
    if (lastToken) payload.access_token = lastToken;
    send(TOPIC, 'phx_join', payload, ref, ref);
  }

  function handleMessage(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || typeof data !== 'object') return;
    if (data.event === 'phx_reply' && data.ref === joinRef && data.topic === TOPIC) {
      const status = data.payload && data.payload.status;
      if (status === 'ok') {
        if (!joined) { joined = true; attempt = 0; emitStatus(); }
      } else {
        // Join refused (e.g. the table is not in the realtime
        // publication yet): drop the socket. The reconnect loop keeps
        // retrying with backoff and polling covers delivery meanwhile.
        try { if (ws) ws.close(); } catch { /* already gone */ }
      }
      return;
    }
    if (data.event === 'postgres_changes' && data.topic === TOPIC) {
      const d = data.payload && data.payload.data;
      if (d && (d.type === 'INSERT' || d.type === 'UPDATE')) {
        try {
          if (onEvent) onEvent({ type: d.type, record: d.record || null, oldRecord: d.old_record || null });
        } catch { /* listener errors must not kill the socket */ }
      }
      return;
    }
    if ((data.event === 'phx_error' || data.event === 'phx_close') && data.topic === TOPIC) {
      try { if (ws) ws.close(); } catch { /* onclose drives the reconnect */ }
    }
  }

  function connect() {
    if (stopped || !coupleId) return;
    if (typeof WebSocket === 'undefined') return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try {
      ws = new WebSocket(wsUrl());
    } catch { scheduleReconnect(); return; }
    ws.onopen = () => { join(); startTimers(); };
    ws.onmessage = (ev) => handleMessage(ev.data);
    ws.onerror = () => { try { if (ws) ws.close(); } catch { /* onclose follows */ } };
    ws.onclose = () => {
      const wasJoined = joined;
      joined = false;
      stopTimers();
      ws = null;
      joinRef = null;
      if (wasJoined) emitStatus();
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (stopped || !coupleId || reconnectTimer) return;
    const delay = nextReconnectDelay(attempt++);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  // Coming back to the tab: do not sit out a backoff — reconnect (and
  // thereby catch up) right away; if already connected, poke a
  // catch-up so anything missed while throttled is picked up.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || stopped || !coupleId) return;
      if (!ws) {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        attempt = 0;
        connect();
      } else if (joined) {
        emitStatus();
      }
    });
  }

  return {
    /** Point the subscription at a couple ('' disconnects). No-op when nothing changed. */
    setCouple(id) {
      const next = id || '';
      if (next === coupleId && (next === '' || ws || reconnectTimer)) return;
      coupleId = next;
      stopped = !next;
      attempt = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) {
        const old = ws;
        ws = null;
        const wasJoined = joined;
        joined = false;
        joinRef = null;
        stopTimers();
        try { old.onclose = null; old.close(); } catch { /* ignore */ }
        if (wasJoined) emitStatus();
      }
      if (coupleId) connect();
    },
    disconnect() { this.setCouple(''); },
    isConnected() { return joined; },
  };
}
