// US & Always — web data layer: plain fetch against the couple's own
// Supabase project (the same backend the Android app uses). The anon key
// is public by design; Row Level Security protects every table, and all
// real access uses the signed-in user's own access token.

export const SUPABASE_URL = 'https://nuftteaifpafarmhqdtd.supabase.co';
export const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im51ZnR0ZWFpZnBhZmFybWhxZHRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3NDg0MzMsImV4cCI6MjExMDMyNDQzM30.0oiugE7cvDFJdnyNPMcy-T6K2Y4yui-u2E8jFtsyP7A';

const LS_SESSION = 'uaw.session';

export function loadSession() {
  try { return JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch { return null; }
}
export function saveSession(session) {
  if (session) localStorage.setItem(LS_SESSION, JSON.stringify(session));
  else localStorage.removeItem(LS_SESSION);
}
export function accessToken() {
  const s = loadSession();
  return s ? s.access_token : '';
}
export function myUserId() {
  const s = loadSession();
  return s && s.user ? s.user.id : '';
}

async function rawFetch(path, { method = 'GET', body, headers = {}, token } = {}) {
  const h = { apikey: ANON_KEY, ...headers };
  const t = token !== undefined ? token : accessToken();
  if (t) h.Authorization = 'Bearer ' + t;
  let payload;
  if (body !== undefined) {
    if (body instanceof ArrayBuffer || body instanceof Uint8Array || body instanceof Blob) {
      payload = body;
    } else {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch(SUPABASE_URL + path, { method, headers: h, body: payload });
  return res;
}

async function ensureFreshToken() {
  const s = loadSession();
  if (!s) return;
  const expiresAt = (s.expires_at || 0) * 1000;
  if (expiresAt && Date.now() > expiresAt - 60000 && s.refresh_token) {
    try {
      const res = await rawFetch('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', body: { refresh_token: s.refresh_token }, token: '',
      });
      if (res.ok) {
        const data = await res.json();
        saveSession({ ...data, user: data.user || s.user });
      }
    } catch { /* keep the old token; the call below will surface any error */ }
  }
}

async function parseResult(res, wantJson = true) {
  const text = await res.text();
  if (!res.ok) {
    let msg = 'Request failed (' + res.status + ')';
    try {
      const j = JSON.parse(text);
      msg = j.message || j.msg || j.error_description || j.error || msg;
    } catch { /* keep default */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (!wantJson || !text) return text;
  return JSON.parse(text);
}

// ---------- Auth ----------
export async function signUp(email, password) {
  const res = await rawFetch('/auth/v1/signup', { method: 'POST', body: { email, password }, token: '' });
  return parseResult(res);
}
export async function logIn(email, password) {
  const res = await rawFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, token: '' });
  const data = await parseResult(res);
  saveSession(data);
  return data;
}
export async function logOut() {
  try {
    await rawFetch('/auth/v1/logout', { method: 'POST' });
  } catch { /* local sign-out is what matters */ }
  saveSession(null);
}

// ---------- REST ----------
export async function rest(path, { method = 'GET', body, prefer } = {}) {
  await ensureFreshToken();
  const headers = {};
  if (prefer) headers.Prefer = prefer;
  const res = await rawFetch('/rest/v1' + path, { method, body, headers });
  return parseResult(res);
}
export const get = (path) => rest(path);
export const post = (path, body, prefer) => rest(path, { method: 'POST', body, prefer });
export const patch = (path, body) => rest(path, { method: 'PATCH', body });
export const del = (path) => rest(path, { method: 'DELETE' });
export async function rpc(name, args) {
  return post('/rpc/' + name, args || {}, undefined);
}

// ---------- Storage (private 'media' bucket) ----------
export async function storageUpload(path, bytes) {
  await ensureFreshToken();
  const res = await rawFetch('/storage/v1/object/media/' + path, {
    method: 'POST', body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
  });
  await parseResult(res, false);
}
export async function storageDownload(path) {
  await ensureFreshToken();
  const res = await rawFetch('/storage/v1/object/media/' + path, { method: 'GET' });
  if (!res.ok) throw new Error('Download failed (' + res.status + ')');
  return new Uint8Array(await res.arrayBuffer());
}
