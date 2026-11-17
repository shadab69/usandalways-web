// US & Always — web E2EE core.
//
// Wire-compatible with the Android app's E2eeCrypto.java:
//   - X25519 key agreement (@noble/curves — a vetted library, no hand-rolled crypto)
//   - HKDF-SHA256 (@noble/hashes), salt = UTF8("USAndAlways-E2EE-v1"),
//     info = the message id, 32-byte output = the per-message AES-256 key
//   - AES-256-GCM via WebCrypto, 12-byte random IV, 128-bit tag
// Chat wire format:  ciphertext = "<uuid>.<base64(ct||tag)>", nonce = base64(iv)
// Combined format:   "<uuid>.<base64 nonce>.<base64 ct>"
// File blob format:  iv(12 raw bytes) || ct||tag, HKDF info = file id
// This module is environment-agnostic (browser + Node >= 19) so the
// cross-check test in ../tests can import the exact production code.

import { x25519, hkdf, sha256, bytesToHex, utf8ToBytes, concatBytes, randomBytes } from './vendor/noble.mjs';

const HKDF_SALT = utf8ToBytes('USAndAlways-E2EE-v1');
const subtle = globalThis.crypto.subtle;
const TE = new TextEncoder();
const TD = new TextDecoder();

// ---------- Base64 (standard alphabet, padded, no wrap — like Java's encoder) ----------
export function b64encode(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}
export function b64decode(text) {
  const s = atob(String(text).replace(/\s+/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function uuid() {
  return globalThis.crypto.randomUUID();
}

// ---------- Keys ----------
export function generateKeyPair() {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}
export function publicFromPrivate(privateKeyRaw) {
  return x25519.getPublicKey(privateKeyRaw);
}
export function publicKeyFromRaw(raw) {
  if (!raw || raw.length !== 32) throw new Error('X25519 public key must be 32 bytes');
  return raw;
}
export function sharedSecret(myPrivate, partnerPublic) {
  return x25519.getSharedSecret(myPrivate, partnerPublic);
}
export function messageKey(myPrivate, partnerPublic, messageId) {
  const shared = sharedSecret(myPrivate, partnerPublic);
  return hkdf(sha256, shared, HKDF_SALT, utf8ToBytes(String(messageId)), 32);
}

// ---------- AES-256-GCM (WebCrypto appends the 16-byte tag to the ciphertext) ----------
async function aesGcmEncrypt(keyBytes, iv, plaintext) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plaintext);
  return new Uint8Array(ct);
}
async function aesGcmDecrypt(keyBytes, iv, ciphertext) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ciphertext);
  return new Uint8Array(pt);
}

// ---------- Chat message format ----------
export async function sealBytes(myPrivate, partnerPublic, messageId, plaintextBytes) {
  const key = messageKey(myPrivate, partnerPublic, messageId);
  const iv = randomBytes(12);
  const ct = await aesGcmEncrypt(key, iv, plaintextBytes);
  return { ciphertextB64: b64encode(ct), nonceB64: b64encode(iv) };
}
export async function openBytes(myPrivate, partnerPublic, messageId, ciphertextB64, nonceB64) {
  const key = messageKey(myPrivate, partnerPublic, messageId);
  return aesGcmDecrypt(key, b64decode(nonceB64), b64decode(ciphertextB64));
}
/** Seals text into the chat wire pair; returns {wire, nonce} where wire = "<uuid>.<b64 ct>". */
export async function sealChatText(myPrivate, partnerPublic, plaintext) {
  const id = uuid();
  const sealed = await sealBytes(myPrivate, partnerPublic, id, TE.encode(plaintext ?? ''));
  return { wire: id + '.' + sealed.ciphertextB64, nonce: sealed.nonceB64 };
}
export async function sealChatBytes(myPrivate, partnerPublic, bytes) {
  const id = uuid();
  const sealed = await sealBytes(myPrivate, partnerPublic, id, bytes);
  return { wire: id + '.' + sealed.ciphertextB64, nonce: sealed.nonceB64 };
}
/** Opens a chat wire value; type 'voice' returns raw bytes, otherwise returns text. */
export async function openChatWire(myPrivate, partnerPublic, wire, nonce, type) {
  const dot = String(wire).indexOf('.');
  if (dot <= 0) throw new Error('Missing client message id');
  const id = wire.substring(0, dot);
  const ct = wire.substring(dot + 1);
  const bytes = await openBytes(myPrivate, partnerPublic, id, ct, nonce);
  return type === 'voice' ? bytes : TD.decode(bytes);
}

// ---------- Combined single-column format ----------
export async function sealCombined(myPrivate, partnerPublic, plaintext) {
  const id = uuid();
  const sealed = await sealBytes(myPrivate, partnerPublic, id, TE.encode(plaintext ?? ''));
  return id + '.' + sealed.nonceB64 + '.' + sealed.ciphertextB64;
}
export async function openCombined(myPrivate, partnerPublic, combined) {
  if (!combined) throw new Error('Missing encrypted value');
  const first = combined.indexOf('.');
  const second = first < 0 ? -1 : combined.indexOf('.', first + 1);
  if (first <= 0 || second <= first + 1 || second >= combined.length - 1) {
    throw new Error('Encrypted value has an unknown format');
  }
  const id = combined.substring(0, first);
  const nonce = combined.substring(first + 1, second);
  const ct = combined.substring(second + 1);
  return TD.decode(await openBytes(myPrivate, partnerPublic, id, ct, nonce));
}

// ---------- File bytes ----------
export async function sealFile(myPrivate, partnerPublic, fileId, data) {
  const sealed = await sealBytes(myPrivate, partnerPublic, fileId, data);
  const iv = b64decode(sealed.nonceB64);
  const ct = b64decode(sealed.ciphertextB64);
  return concatBytes(iv, ct);
}
export async function openFile(myPrivate, partnerPublic, fileId, blob) {
  if (!blob || blob.length <= 12) throw new Error('Encrypted file is too short');
  const iv = blob.subarray(0, 12);
  const ct = blob.subarray(12);
  const key = messageKey(myPrivate, partnerPublic, fileId);
  return aesGcmDecrypt(key, iv, ct);
}
export function fileIdFromPath(storagePath) {
  if (!storagePath) return '';
  const slash = storagePath.lastIndexOf('/');
  let name = slash >= 0 ? storagePath.substring(slash + 1) : storagePath;
  if (name.endsWith('.bin')) name = name.substring(0, name.length - 4);
  return name;
}

// ---------- Safety number (identical derivation to E2eeCrypto.safetyNumber) ----------
export function safetyNumber(publicKeyA, publicKeyB) {
  if (!publicKeyA || !publicKeyB || publicKeyA.length !== 32 || publicKeyB.length !== 32) {
    throw new Error('Safety number needs two 32-byte public keys');
  }
  let first = publicKeyA, second = publicKeyB;
  for (let i = 0; i < 32; i++) {
    if (first[i] !== second[i]) { if (first[i] > second[i]) { first = publicKeyB; second = publicKeyA; } break; }
  }
  const hash = sha256(concatBytes(first, second));
  const hex = bytesToHex(hash).substring(0, 60);
  const groups = [];
  for (let i = 0; i < hex.length; i += 5) groups.push(hex.substring(i, Math.min(i + 5, hex.length)));
  return groups.join(' ');
}

// ---------- Private-key wrapping under the account password ----------
// PBKDF2-HMAC-SHA256 (120,000 iterations, same count as Android's CryptoUtil)
// derives an AES-256-GCM key that encrypts the raw 32-byte private key.
// Stored shape (JSON in localStorage): {salt, iv, ct} — all base64.
const PBKDF2_ITERATIONS = 120000;
async function deriveWrapKey(password, salt) {
  const base = await subtle.importKey('raw', TE.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function wrapPrivateKey(privateKeyRaw, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveWrapKey(password, salt);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, privateKeyRaw));
  return JSON.stringify({ salt: b64encode(salt), iv: b64encode(iv), ct: b64encode(ct) });
}
export async function unwrapPrivateKey(wrappedJson, password) {
  const w = JSON.parse(wrappedJson);
  const key = await deriveWrapKey(password, b64decode(w.salt));
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(w.iv), tagLength: 128 }, key, b64decode(w.ct));
  return new Uint8Array(pt);
}

// ---------- PIN hashing (PBKDF2-HMAC-SHA256, 120k iterations, hex — like Android's Vault) ----------
export async function hashSecretHex(secret, saltBytes) {
  const base = await subtle.importKey('raw', TE.encode(secret ?? ''), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, base, 256);
  return bytesToHex(new Uint8Array(bits));
}
export function newSalt() { return randomBytes(16); }
export { bytesToHex };
export function hexToBytesLocal(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
