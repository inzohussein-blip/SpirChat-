package org.spirchat.engine

import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.nio.ByteBuffer
import java.security.MessageDigest

/** Port of packages/protocol/src/envelope.ts validation. Keep the two in lockstep. */
object Protocol {
    const val VERSION = 1
    private const val HOUR = 3_600_000L
    private const val DAY = 24 * HOUR
    const val MAX_FUTURE_SKEW = DAY
    const val MAX_HAVE_IDS = 5000

    class Rules(val priority: Int, val maxBytes: Int, val maxTtl: Long, val powBits: Int)

    val RULES = mapOf(
        "sos" to Rules(0, 1024, 3 * DAY, 10),
        "alert" to Rules(0, 4096, 7 * DAY, 0),
        "dm" to Rules(1, 256 * 1024, 30 * DAY, 12),
        "room" to Rules(2, 8 * 1024, 14 * DAY, 12),
        "profile" to Rules(3, 2048, 365 * DAY, 10),
        "post" to Rules(3, 256 * 1024, 60 * DAY, 14),
    )

    private val SEALED_FIELDS = setOf("v", "kind", "ts", "exp", "to", "epk", "ct", "nonce", "id")
    private val SIGNED_FIELDS = setOf("v", "kind", "ts", "exp", "author", "body", "sig", "nonce", "id")
    private val DATA_URL = Regex("^data:image/(webp|jpeg|png);base64,")
    private val ROOM_NAME = Regex("^[\\p{L}\\p{N}_-]+$")

    fun sha256(vararg parts: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        parts.forEach(md::update)
        return md.digest()
    }

    fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    fun mailboxTag(id: String): String = B64u.encode(sha256(utf8("spirchat/tag/v1:"), B64u.decode(id)).copyOf(16))

    fun leadingZeroBits(bytes: ByteArray): Int {
        var n = 0
        for (b in bytes) {
            val v = b.toInt() and 0xff
            if (v == 0) {
                n += 8
                continue
            }
            return n + Integer.numberOfLeadingZeros(v) - 24
        }
        return n
    }

    fun verifySignature(id: String, message: ByteArray, signature: String): Boolean = try {
        val signer = Ed25519Signer()
        signer.init(false, Ed25519PublicKeyParameters(B64u.decode(id), 0))
        signer.update(message, 0, message.size)
        signer.verifySignature(B64u.decode(signature))
    } catch (_: Exception) {
        false
    }

    fun priorityOf(env: Json.Obj): Int {
        val kind = env.str("kind") ?: return 99
        val p = RULES[kind]?.priority ?: return 99
        return if (kind == "post" && env.obj("body")?.str("image") != null) p + 1 else p
    }

    private fun isStr(v: Json?, max: Int, min: Int = 0) = v is Json.Str && v.value.length in min..max
    private fun isDataUrl(v: Json?, max: Int) = isStr(v, max) && DATA_URL.containsMatchIn((v as Json.Str).value)

    private val AREA = Regex("^[\\p{L}\\p{N}_-]{1,32}(/[\\p{L}\\p{N}_-]{1,32}){0,3}$")
    private val B64U_43 = Regex("^[A-Za-z0-9_-]{43}$")
    const val MAX_MEDIA_BYTES = 1_000_000
    private val NEED_CATEGORIES = setOf("medicine", "food", "water", "power", "transport", "shelter", "other")

    private fun isArea(v: Json?) = isStr(v, 100, 1) && AREA.matches((v as Json.Str).value)

    private fun isMedia(v: Json?): Boolean {
        val m = v as? Json.Obj ?: return false
        val size = m.long("size")
        return m.fields.keys.all { it in setOf("id", "size", "mime") } &&
            m.str("id")?.let(B64U_43::matches) == true &&
            size != null && size in 1..MAX_MEDIA_BYTES.toLong() &&
            m.str("mime") in setOf("image/webp", "image/jpeg")
    }

    private fun isPostTag(v: Json?): Boolean {
        val t = v as? Json.Obj ?: return false
        val n = t.fields.size
        return when (t.str("type")) {
            "need", "offer" -> n == 2 && t.str("cat") in NEED_CATEGORIES
            "safe" -> n == 1
            "missing" -> n == 2 && isStr(t["name"], 60, 1)
            else -> false
        }
    }

    private fun validKeys(v: Json?): Boolean {
        val arr = (v as? Json.Arr)?.items ?: return false
        return arr.size <= 3 && arr.all { k ->
            k is Json.Obj && isStr(k["k"], 43, 43) && k.long("until") != null
        }
    }

    fun validateBody(kind: String, body: Json?): String? {
        if (kind == "dm") return if (body == null) null else "dm must not have a body"
        val b = body as? Json.Obj ?: return "body must be an object"
        return when (kind) {
            "profile" -> when {
                !isStr(b["name"], 40, 1) -> "profile.name must be 1-40 chars"
                b["bio"] != null && !isStr(b["bio"], 160) -> "profile.bio too long"
                b["keys"] != null && !validKeys(b["keys"]) -> "profile.keys invalid"
                else -> null
            }
            "post" -> when {
                !isStr(b["text"], 2000) -> "post.text too long"
                b["image"] != null && !isDataUrl(b["image"], 240_000) -> "post.image invalid"
                b["thumb"] != null && !isDataUrl(b["thumb"], 12_000) -> "post.thumb invalid"
                b["media"] != null && !isMedia(b["media"]) -> "post.media invalid"
                b["area"] != null && !isArea(b["area"]) -> "post.area invalid"
                b["tag"] != null && !isPostTag(b["tag"]) -> "post.tag invalid"
                b.str("text").isNullOrEmpty() && b["image"] == null && b["media"] == null &&
                    (b["tag"] as? Json.Obj)?.str("type") != "safe" -> "post is empty"
                else -> null
            }
            "room" -> when {
                !isStr(b["room"], 32, 1) || !ROOM_NAME.matches(b.str("room")!!) -> "room name invalid"
                !isStr(b["text"], 2000, 1) -> "room.text must be 1-2000 chars"
                b["area"] != null && !isArea(b["area"]) -> "room.area invalid"
                else -> null
            }
            "alert" -> when {
                !isStr(b["title"], 100, 1) || !isStr(b["text"], 1000) -> "alert text invalid"
                b.str("level") !in setOf("info", "warning", "danger") -> "alert.level invalid"
                else -> null
            }
            "sos" -> when {
                !isStr(b["text"], 280, 1) -> "sos.text must be 1-280 chars"
                b["area"] != null && !isArea(b["area"]) -> "sos.area invalid"
                b["loc"] == null -> null
                else -> {
                    val loc = b["loc"] as? Json.Obj
                    val lat = loc?.num("lat")
                    val lon = loc?.num("lon")
                    if (lat != null && Math.abs(lat) <= 90 && lon != null && Math.abs(lon) <= 180) null else "sos.loc invalid"
                }
            }
            else -> "unknown kind"
        }
    }

    private fun powHash(env: Json.Obj, nonce: Long): ByteArray {
        val base = sha256(utf8(env.without("nonce", "id").canonical()))
        return sha256(base, ByteBuffer.allocate(4).putInt(nonce.toInt()).array())
    }

    /** Returns null if valid, otherwise the reason. */
    fun validate(input: Json, now: Long = System.currentTimeMillis()): String? {
        val env = input as? Json.Obj ?: return "not an object"
        if (env.num("v") != VERSION.toDouble()) return "unsupported version"
        val kind = env.str("kind") ?: return "unknown kind"
        val rules = RULES[kind] ?: return "unknown kind"
        val ts = env.long("ts") ?: return "bad timestamps"
        val exp = env.long("exp") ?: return "bad timestamps"
        if (ts > now + MAX_FUTURE_SKEW) return "timestamp in the future"
        if (exp <= ts || exp - ts > rules.maxTtl) return "bad lifetime"
        if (exp < now) return "expired"
        val nonce = env.long("nonce")
        if (nonce == null || nonce < 0 || nonce >= (1L shl 32)) return "bad nonce"
        if (utf8(env.stringify()).size > rules.maxBytes) return "too large"

        val allowed = if (kind == "dm") SEALED_FIELDS else SIGNED_FIELDS
        if (env.fields.keys.any { it !in allowed }) return "unexpected field"

        if (kind == "dm") {
            if (!isStr(env["to"], 32, 1) || !isStr(env["epk"], 64, 1) || !isStr(env["ct"], rules.maxBytes, 1)) {
                return "bad sealed fields"
            }
        } else {
            if (!isStr(env["author"], 64, 1) || !isStr(env["sig"], 128, 1)) return "missing author or sig"
            validateBody(kind, env["body"])?.let { return it }
            val signed = Json.Obj(
                listOf("v", "kind", "ts", "exp", "author", "body").mapNotNull { k -> env[k]?.let { k to it } }.toMap(),
            )
            if (!verifySignature(env.str("author")!!, utf8(signed.canonical()), env.str("sig")!!)) return "bad signature"
        }

        val h = powHash(env, nonce)
        if (B64u.encode(h) != env.str("id")) return "id mismatch"
        if (leadingZeroBits(h) < rules.powBits) return "insufficient proof of work"
        return null
    }
}

/** Unpadded base64url, as used throughout the protocol. */
object B64u {
    private val enc = java.util.Base64.getUrlEncoder().withoutPadding()
    private val dec = java.util.Base64.getUrlDecoder()

    fun encode(b: ByteArray): String = enc.encodeToString(b)
    fun decode(s: String): ByteArray = dec.decode(s)
}
