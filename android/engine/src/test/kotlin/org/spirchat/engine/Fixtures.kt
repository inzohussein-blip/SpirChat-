package org.spirchat.engine

import java.io.File
import java.util.concurrent.TimeUnit

object Fixtures {
    val repo = File(System.getProperty("spirchat.repo") ?: "../..")

    fun nodeAvailable(): Boolean = try {
        ProcessBuilder("node", "--version").start().waitFor(10, TimeUnit.SECONDS)
    } catch (_: Exception) {
        false
    }

    /** Fresh envelopes from the TypeScript library, so tests never depend on the date. */
    fun fresh(count: Int = 3): Json.Obj {
        val p = ProcessBuilder("node", "packages/protocol/scripts/fixture.ts", count.toString())
            .directory(repo).redirectErrorStream(false).start()
        val out = p.inputStream.bufferedReader().readText()
        check(p.waitFor(60, TimeUnit.SECONDS) && p.exitValue() == 0) { "fixture script failed" }
        return Json.parse(out) as Json.Obj
    }

    fun list(o: Json.Obj, key: String) = (o[key] as Json.Arr).items.map { it as Json.Obj }

    /** Waits until [cond] holds, failing after [timeoutMs]. */
    fun eventually(timeoutMs: Long = 10_000, message: String = "condition", cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return
            Thread.sleep(50)
        }
        throw AssertionError("timed out waiting for $message")
    }
}
