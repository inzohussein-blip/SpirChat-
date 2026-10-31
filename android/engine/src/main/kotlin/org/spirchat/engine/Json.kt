package org.spirchat.engine

import java.math.BigDecimal

/**
 * Minimal JSON model whose serialisation matches JavaScript's `JSON.stringify` byte for byte.
 * Signatures and proof-of-work hash canonical JSON, so the engine must produce exactly the same
 * bytes as packages/protocol/src/encoding.ts for any envelope.
 */
sealed class Json {
    object Null : Json()
    data class Bool(val value: Boolean) : Json()
    data class Num(val value: Double) : Json()
    data class Str(val value: String) : Json()
    data class Arr(val items: List<Json>) : Json()
    data class Obj(val fields: Map<String, Json>) : Json() {
        operator fun get(key: String): Json? = fields[key]
        fun str(key: String): String? = (fields[key] as? Str)?.value
        fun num(key: String): Double? = (fields[key] as? Num)?.value
        fun long(key: String): Long? = num(key)?.takeIf { it == Math.floor(it) && Math.abs(it) <= MAX_SAFE }?.toLong()
        fun obj(key: String): Obj? = fields[key] as? Obj
        fun without(vararg keys: String) = Obj(fields.filterKeys { it !in keys })
    }

    /** Sorted keys, no whitespace: same as canonicalJson() in TypeScript. */
    fun canonical(): String = StringBuilder().also { write(it, sorted = true) }.toString()

    /** Keys in insertion order, like JSON.stringify. */
    fun stringify(): String = StringBuilder().also { write(it, sorted = false) }.toString()

    private fun write(out: StringBuilder, sorted: Boolean) {
        when (this) {
            Null -> out.append("null")
            is Bool -> out.append(value)
            is Num -> out.append(jsNumber(value))
            is Str -> quote(value, out)
            is Arr -> {
                out.append('[')
                items.forEachIndexed { i, v ->
                    if (i > 0) out.append(',')
                    v.write(out, sorted)
                }
                out.append(']')
            }
            is Obj -> {
                out.append('{')
                val keys = if (sorted) fields.keys.sorted() else fields.keys
                keys.forEachIndexed { i, k ->
                    if (i > 0) out.append(',')
                    quote(k, out)
                    out.append(':')
                    fields.getValue(k).write(out, sorted)
                }
                out.append('}')
            }
        }
    }

    companion object {
        const val MAX_SAFE = 9007199254740991.0

        fun obj(vararg pairs: Pair<String, Json>) = Obj(linkedMapOf(*pairs))
        fun str(s: String) = Str(s)
        fun num(n: Number) = Num(n.toDouble())

        fun parse(text: String): Json = Parser(text).parseDocument()

        /** JSON.stringify string escaping, including well-formed escapes for lone surrogates. */
        fun quote(s: String, out: StringBuilder) {
            out.append('"')
            var i = 0
            while (i < s.length) {
                val c = s[i]
                when {
                    c == '"' -> out.append("\\\"")
                    c == '\\' -> out.append("\\\\")
                    c == '\b' -> out.append("\\b")
                    c == '\u000C' -> out.append("\\f")
                    c == '\n' -> out.append("\\n")
                    c == '\r' -> out.append("\\r")
                    c == '\t' -> out.append("\\t")
                    c < ' ' -> out.append("\\u").append(hex4(c))
                    Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                        out.append(c).append(s[i + 1])
                        i++
                    }
                    Character.isSurrogate(c) -> out.append("\\u").append(hex4(c))
                    else -> out.append(c)
                }
                i++
            }
            out.append('"')
        }

        private fun hex4(c: Char) = Integer.toHexString(c.code).padStart(4, '0')

        /** ECMAScript Number::toString for finite doubles. */
        fun jsNumber(d: Double): String {
            require(!d.isNaN() && !d.isInfinite()) { "non-finite number" }
            if (d == 0.0) return "0"
            if (d == Math.floor(d) && Math.abs(d) < 1e21) return BigDecimal(d).toPlainString()
            val neg = d < 0
            // Shortest digits that round-trip (JDKs before 19 and Android do not guarantee this
            // from Double.toString), then laid out as JavaScript does.
            val exact = BigDecimal(Math.abs(d))
            val bd = (1..17).asSequence()
                .map { exact.round(java.math.MathContext(it, java.math.RoundingMode.HALF_EVEN)) }
                .first { it.toDouble() == Math.abs(d) }
                .stripTrailingZeros()
            val digits = bd.unscaledValue().toString()
            val k = digits.length
            val n = k - bd.scale() // decimal point position: value = 0.digits * 10^n
            val body = when {
                n in k..21 -> digits + "0".repeat(n - k)
                n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
                n in -5..0 -> "0." + "0".repeat(-n) + digits
                else -> {
                    val e = n - 1
                    val exp = if (e >= 0) "e+$e" else "e$e"
                    (if (k == 1) digits else digits[0] + "." + digits.substring(1)) + exp
                }
            }
            return if (neg) "-$body" else body
        }
    }

    private class Parser(private val s: String) {
        private var i = 0

        fun parseDocument(): Json {
            val v = value()
            ws()
            if (i != s.length) fail("trailing characters")
            return v
        }

        private fun fail(msg: String): Nothing = throw IllegalArgumentException("invalid JSON at $i: $msg")

        private fun ws() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++
        }

        private fun value(): Json {
            ws()
            if (i >= s.length) fail("unexpected end")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> Str(string())
                't' -> literal("true", Bool(true))
                'f' -> literal("false", Bool(false))
                'n' -> literal("null", Null)
                else -> if (c == '-' || c in '0'..'9') number() else fail("unexpected '$c'")
            }
        }

        private fun literal(word: String, v: Json): Json {
            if (!s.startsWith(word, i)) fail("expected $word")
            i += word.length
            return v
        }

        private fun obj(): Obj {
            i++
            val fields = LinkedHashMap<String, Json>()
            ws()
            if (i < s.length && s[i] == '}') {
                i++
                return Obj(fields)
            }
            while (true) {
                ws()
                if (i >= s.length || s[i] != '"') fail("expected key")
                val k = string()
                ws()
                if (i >= s.length || s[i] != ':') fail("expected ':'")
                i++
                fields[k] = value()
                ws()
                if (i >= s.length) fail("unterminated object")
                when (s[i++]) {
                    ',' -> continue
                    '}' -> return Obj(fields)
                    else -> fail("expected ',' or '}'")
                }
            }
        }

        private fun arr(): Arr {
            i++
            val items = ArrayList<Json>()
            ws()
            if (i < s.length && s[i] == ']') {
                i++
                return Arr(items)
            }
            while (true) {
                items.add(value())
                ws()
                if (i >= s.length) fail("unterminated array")
                when (s[i++]) {
                    ',' -> continue
                    ']' -> return Arr(items)
                    else -> fail("expected ',' or ']'")
                }
            }
        }

        private fun string(): String {
            i++
            val out = StringBuilder()
            while (true) {
                if (i >= s.length) fail("unterminated string")
                val c = s[i++]
                when {
                    c == '"' -> return out.toString()
                    c == '\\' -> {
                        if (i >= s.length) fail("bad escape")
                        when (val e = s[i++]) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail("bad unicode escape")
                                out.append(s.substring(i, i + 4).toInt(16).toChar())
                                i += 4
                            }
                            else -> fail("bad escape '$e'")
                        }
                    }
                    c < ' ' -> fail("control character in string")
                    else -> out.append(c)
                }
            }
        }

        private fun number(): Num {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && (s[i].isDigit() || s[i] in ".eE+-")) i++
            val text = s.substring(start, i)
            return Num(text.toDoubleOrNull() ?: fail("bad number '$text'"))
        }
    }
}
