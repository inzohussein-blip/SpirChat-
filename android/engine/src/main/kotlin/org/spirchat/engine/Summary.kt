package org.spirchat.engine

/** Port of packages/protocol/src/summary.ts: per-day [day, count, xor] buckets of envelope IDs. */
object Summary {
    const val DAY = 86_400_000L

    data class Bucket(val day: Long, val count: Int, val xor: String)

    fun summarize(items: Collection<Pair<String, Long>>): List<Bucket> {
        val days = sortedMapOf<Long, Pair<Int, ByteArray>>()
        for ((id, ts) in items) {
            val d = Math.floorDiv(ts, DAY)
            val (n, x) = days.getOrPut(d) { 0 to ByteArray(8) }
            val bytes = B64u.decode(id)
            for (i in 0 until 8) x[i] = (x[i].toInt() xor (bytes.getOrElse(i) { 0 }.toInt())).toByte()
            days[d] = (n + 1) to x
        }
        return days.map { (d, v) -> Bucket(d, v.first, v.second.joinToString("") { "%02x".format(it.toInt() and 0xff) }) }
    }

    fun differingDays(mine: List<Bucket>, theirs: List<Bucket>): List<Long> {
        val other = theirs.associate { it.day to "${it.count}:${it.xor}" }
        return mine.filter { other[it.day] != "${it.count}:${it.xor}" }.map { it.day }
    }

    fun toJson(buckets: List<Bucket>): Json = Json.Arr(
        buckets.map { Json.Arr(listOf(Json.num(it.day), Json.num(it.count), Json.str(it.xor))) },
    )

    private val HEX16 = Regex("^[0-9a-f]{16}$")

    fun fromJson(v: Json?): List<Bucket>? {
        val arr = (v as? Json.Arr)?.items ?: return null
        if (arr.size > 400) return null
        return arr.map { b ->
            val t = (b as? Json.Arr)?.items ?: return null
            if (t.size != 3) return null
            val day = (t[0] as? Json.Num)?.value?.toLong() ?: return null
            val n = (t[1] as? Json.Num)?.value?.toInt() ?: return null
            val x = (t[2] as? Json.Str)?.value?.takeIf(HEX16::matches) ?: return null
            Bucket(day, n, x)
        }
    }
}
