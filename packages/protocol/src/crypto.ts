import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { b64u, concat, fromB64u, utf8 } from './encoding.ts';

export { sha256, randomBytes };

export interface Identity {
  /** Ed25519 secret seed (32 bytes). Everything else is derived from it. */
  seed: Uint8Array;
  /** Ed25519 public key, base64url. This is the user's ID. */
  id: string;
}

export function newIdentity(): Identity {
  return identityFromSeed(ed25519.utils.randomSecretKey());
}

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  return { seed, id: b64u(ed25519.getPublicKey(seed)) };
}

export function sign(identity: Identity, message: Uint8Array): string {
  return b64u(ed25519.sign(message, identity.seed));
}

export function verify(id: string, message: Uint8Array, signature: string): boolean {
  try {
    return ed25519.verify(fromB64u(signature), message, fromB64u(id));
  } catch {
    return false;
  }
}

/**
 * Opaque mailbox tag for a recipient. Hubs and carriers route direct messages
 * by this tag; only someone who already knows the recipient's ID can link them.
 */
export function mailboxTag(id: string): string {
  return b64u(sha256(concat(utf8('spirchat/tag/v1:'), fromB64u(id))).subarray(0, 16));
}

/** Short human-comparable fingerprint of an ID, for verifying contacts in person. */
export function fingerprint(id: string): string {
  const h = sha256(concat(utf8('spirchat/fp/v1:'), fromB64u(id)));
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) {
    const n = ((h[i * 2]! << 8) | h[i * 2 + 1]!) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups.join(' ');
}

function sealKey(shared: Uint8Array, ephPub: Uint8Array, recipientX: Uint8Array) {
  const okm = hkdf(sha256, shared, concat(ephPub, recipientX), utf8('spirchat/seal/v1'), 56);
  return { key: okm.subarray(0, 32), nonce: okm.subarray(32, 56) };
}

/**
 * Anonymous public-key encryption to an X25519 public key (ephemeral X25519 +
 * XChaCha20-Poly1305). The key is single-use, so the derived nonce is safe.
 */
export function sealToKey(recipientX: Uint8Array, plaintext: Uint8Array): { epk: string; ct: string } {
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const { key, nonce } = sealKey(x25519.getSharedSecret(eph, recipientX), ephPub, recipientX);
  return { epk: b64u(ephPub), ct: b64u(xchacha20poly1305(key, nonce).encrypt(plaintext)) };
}

/** Encrypts to the long-term key of an identity. */
export function seal(recipientId: string, plaintext: Uint8Array): { epk: string; ct: string } {
  return sealToKey(ed25519.utils.toMontgomery(fromB64u(recipientId)), plaintext);
}

/** Tries one X25519 secret; null if it is not the right key or the data was tampered with. */
export function openWithKey(secretX: Uint8Array, epk: string, ct: string): Uint8Array | null {
  try {
    const ephPub = fromB64u(epk);
    const recipientX = x25519.getPublicKey(secretX);
    const { key, nonce } = sealKey(x25519.getSharedSecret(secretX, ephPub), ephPub, recipientX);
    return xchacha20poly1305(key, nonce).decrypt(fromB64u(ct));
  } catch {
    return null;
  }
}

/** Returns null if the message was not for this identity or was tampered with. */
export function open(identity: Identity, epk: string, ct: string): Uint8Array | null {
  return openWithKey(ed25519.utils.toMontgomerySecret(identity.seed), epk, ct);
}

/**
 * A short-lived encryption key ("prekey"), published in the profile and replaced weekly.
 * Messages sealed to it cannot be read once its secret is deleted, even if the identity
 * key is stolen later.
 */
export function newPrekey(): { secret: string; pub: string } {
  const secret = x25519.utils.randomSecretKey();
  return { secret: b64u(secret), pub: b64u(x25519.getPublicKey(secret)) };
}

/** Mailbox tag shared by the members of a private group. */
export function groupTag(groupId: string): string {
  return b64u(sha256(concat(utf8('spirchat/group/v1:'), fromB64u(groupId))).subarray(0, 16));
}

function groupKeyFor(groupKey: Uint8Array, salt: Uint8Array) {
  const okm = hkdf(sha256, groupKey, salt, utf8('spirchat/group/v1'), 56);
  return { key: okm.subarray(0, 32), nonce: okm.subarray(32, 56) };
}

/**
 * Symmetric encryption for group messages. `epk` is a random per-message salt, so on the
 * wire a group message looks exactly like a private message.
 */
export function groupSeal(groupKey: Uint8Array, plaintext: Uint8Array): { epk: string; ct: string } {
  const salt = randomBytes(32);
  const { key, nonce } = groupKeyFor(groupKey, salt);
  return { epk: b64u(salt), ct: b64u(xchacha20poly1305(key, nonce).encrypt(plaintext)) };
}

export function groupOpen(groupKey: Uint8Array, epk: string, ct: string): Uint8Array | null {
  try {
    const { key, nonce } = groupKeyFor(groupKey, fromB64u(epk));
    return xchacha20poly1305(key, nonce).decrypt(fromB64u(ct));
  } catch {
    return null;
  }
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

/** Identity seed encrypted with a PIN (scrypt + XChaCha20-Poly1305), for storage at rest. */
export interface LockedSeed {
  salt: string;
  nonce: string;
  ct: string;
  /** scrypt cost exponent (N = 2^n). */
  n: number;
}

async function pinKey(pin: string, salt: Uint8Array, n: number): Promise<Uint8Array> {
  const { scryptAsync } = await import('@noble/hashes/scrypt.js');
  return scryptAsync(utf8(`spirchat/pin/v1:${pin}`), salt, { N: 2 ** n, r: 8, p: 1, dkLen: 32 });
}

export async function lockSeed(seed: Uint8Array, pin: string, n = 15): Promise<LockedSeed> {
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = await pinKey(pin, salt, n);
  return { salt: b64u(salt), nonce: b64u(nonce), ct: b64u(xchacha20poly1305(key, nonce).encrypt(seed)), n };
}

/** The seed, or null if the PIN is wrong. */
export async function unlockSeed(lock: LockedSeed, pin: string): Promise<Uint8Array | null> {
  try {
    const key = await pinKey(pin, fromB64u(lock.salt), lock.n);
    return xchacha20poly1305(key, fromB64u(lock.nonce)).decrypt(fromB64u(lock.ct));
  } catch {
    return null;
  }
}

/** Verifier for a secondary PIN (duress PIN) without storing it. */
export async function pinVerifier(pin: string, salt: string, n = 15): Promise<string> {
  return b64u(await pinKey(pin, fromB64u(salt), n));
}
