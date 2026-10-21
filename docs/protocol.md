# SpirChat protocol v1

The reference implementation is `packages/protocol`. This document describes what it does;
if they disagree, the code wins, and the disagreement is a bug.

## Identity

- Identity = an Ed25519 key pair generated on the device. The **ID** is the base64url
  (unpadded) public key. No phone number, email or registration server.
- The same key is converted to X25519 (RFC 7748 birational map) to receive encrypted messages.
- **Mailbox tag** = `base64url(SHA-256("spirchat/tag/v1:" || pubkey)[0..16])`. Direct messages
  are addressed by tag. Anyone who already knows your ID can compute your tag. Anyone else sees
  only an opaque value.
- **Fingerprint** = six 5-digit groups derived from `SHA-256("spirchat/fp/v1:" || pubkey)`.
  Compare it in person to verify a contact.

## Envelope

Everything that moves through the network is an immutable JSON **envelope**:

| field | signed kinds | `dm` | meaning |
|---|---|---|---|
| `v` | ✓ | ✓ | protocol version, `1` |
| `kind` | ✓ | ✓ | `profile` `post` `room` `alert` `sos` / `dm` |
| `ts`, `exp` | ✓ | ✓ | creation and expiry times (ms). Carriers drop expired envelopes |
| `author`, `body`, `sig` | ✓ | | author ID, kind-specific body, Ed25519 signature |
| `to`, `epk`, `ct` | | ✓ | recipient tag, ephemeral X25519 key, ciphertext |
| `nonce`, `id` | ✓ | ✓ | proof-of-work counter and resulting ID |

**Signature** (signed kinds): Ed25519 over `canonicalJson({v, kind, ts, exp, author, body})`.
Canonical JSON means object keys sorted, no whitespace, and `undefined` fields dropped.

**ID and proof of work:**
`base = SHA-256(canonicalJson(envelope without nonce and id))` and
`id = base64url(SHA-256(base || uint32be(nonce)))`. The ID hash must start with at least
`powBits(kind)` zero bits. This makes flooding the network costly. The ID also deduplicates
and addresses the envelope everywhere.

### Kinds and limits

| kind | priority | max size | max TTL | PoW bits | body |
|---|---|---|---|---|---|
| `sos` | 0 | 1 KB | 3 d | 10 | `{text ≤280, loc?: {lat, lon}}` |
| `alert` | 0 | 4 KB | 7 d | 0 | `{title, text, level}`. Hubs accept only configured keys |
| `dm` | 1 | 256 KB | 30 d | 12 | sealed (see below) |
| `room` | 2 | 8 KB | 14 d | 12 | `{room, text}`. Public group chat |
| `profile` | 3 | 2 KB | 365 d | 10 | `{name, bio?}`. The latest one wins |
| `post` | 3 (4 with image) | 256 KB | 60 d | 14 | `{text, image?, thumb?}` as data URLs |

Lower priority numbers are sent first and evicted last.

### Direct messages (`dm`)

1. Inner message `{from, to, ts, text, image?}` is signed by the sender:
   `sig = Ed25519(canonicalJson(inner))`.
2. `JSON(inner + sig)` is encrypted with an ephemeral X25519 key to the recipient:
   `shared = X25519(eph, recipientX)` and
   `key‖nonce = HKDF-SHA256(shared, salt = ephPub‖recipientX, info = "spirchat/seal/v1", 56)`.
   The cipher is XChaCha20-Poly1305. The key is single-use, so the derived nonce is safe.
3. The outer envelope carries only `to` (the tag), `epk` and `ct`. Carriers do not learn the
   sender or the content. The recipient checks that the inner `to` is their own ID and that the
   inner `ts` equals the outer `ts`, which prevents re-addressing and replay with another time.

Known limitations of v1:
- There is no forward secrecy: a stolen key decrypts past captured messages.
- The tag links messages to the same recipient.
- Group chats are public rooms only.

## Client ↔ hub (WebSocket `/ws`)

```
client → hello {hubId?, since?}      hub → welcome {hubId, name, seq, alertKeys}
                                     hub → env {seq, env}…   (urgent first: priority 0–2, then 3+)
                                     hub → synced {seq}      (save as cursor for this hubId)
client → have {ids[≤5000]}           hub → want {ids}        (what the hub lacks)
client → publish {env}               hub → ack {id, ok, error?}
                                     hub → env {seq, env}    (live, as others publish)
```

Clients keep every envelope they receive. Each time they connect to any hub they offer
everything they hold through `have`/`want`. That is how a phone carries messages between
neighbourhoods. Clients validate everything they receive and do not trust the hub.

## Hub ↔ hub (HTTP)

- `GET /api/sync?since=N&limit=M` returns `{hubId, items:[{seq, env}], last, more}`. A hub
  pulls from each peer in `PEERS` and stores a cursor per peer.
- `GET /api/export` returns an NDJSON bundle of every live envelope, for USB sticks and phones.
- `POST /api/envelopes` takes an NDJSON or JSON array and imports it, with full validation.
