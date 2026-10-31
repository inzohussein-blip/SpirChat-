package org.spirchat.engine

import okhttp3.OkHttpClient
import java.io.File
import java.net.ServerSocket
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Runs the engine against the real Node hub (hub/src/main.ts). */
class HubIntegrationTest {
    private var hub: Process? = null
    private var port = 0
    private val client = OkHttpClient()

    @BeforeTest
    fun startHub() {
        org.junit.jupiter.api.Assumptions.assumeTrue(Fixtures.nodeAvailable(), "node is required")
        port = ServerSocket(0).use { it.localPort }
        val data = Files.createTempDirectory("spirchat-hub").toFile()
        hub = ProcessBuilder("node", "--disable-warning=ExperimentalWarning", "hub/src/main.ts")
            .directory(Fixtures.repo)
            .redirectOutput(File(data, "hub.log"))
            .redirectErrorStream(true)
            .apply {
                environment()["PORT"] = port.toString()
                environment()["HOST"] = "127.0.0.1"
                environment()["DATA_DIR"] = data.absolutePath
                environment()["HUB_NAME"] = "Test"
            }
            .start()
        Fixtures.eventually(15_000, "hub to listen") {
            try {
                java.net.Socket("127.0.0.1", port).close()
                true
            } catch (_: Exception) {
                false
            }
        }
    }

    @AfterTest
    fun stopHub() {
        hub?.destroy()
    }

    private fun manager(engine: Engine, internet: Boolean): HubManager {
        val m = HubManager(engine, { client }, client)
        val addr = "http://127.0.0.1:$port"
        m.start(if (internet) HubManager.Config(internetHubs = listOf(addr)) else HubManager.Config(localCandidates = listOf("nowhere.invalid", "127.0.0.1:$port")))
        return m
    }

    @Test
    fun phonesExchangeThroughLocalAndInternetHubs() {
        val fx = Fixtures.fresh(2)
        val posts = Fixtures.list(fx, "posts")
        val sara = Engine(MemoryStore())
        posts.forEach { sara.accept(it, null) }

        // Sara reaches the hub over Wi-Fi (after one dead candidate) and uploads what she carries.
        val m1 = manager(sara, internet = false)
        Fixtures.eventually(message = "sara online") { m1.status().first().state == "online" }
        Fixtures.eventually(message = "delivered") { posts.all { sara.delivered.contains(it.str("id")) } }

        // Omar abroad connects to the same hub as an internet hub and receives everything.
        val omar = Engine(MemoryStore())
        val m2 = manager(omar, internet = true)
        Fixtures.eventually(message = "omar receives posts") { posts.all { omar.store.contains(it.str("id")!!) } }

        // Live: Omar's reply reaches Sara without reconnecting.
        val dm = fx.obj("dm")!!
        omar.accept(dm, null)
        Fixtures.eventually(message = "dm reaches sara") { sara.store.contains(dm.str("id")!!) }

        val statuses = m2.status()
        assertEquals(2, statuses.size)
        assertTrue(statuses.any { it.internet && it.state == "online" && it.name == "Test" })
        m1.shutdown()
        m2.shutdown()
    }

    @Test
    fun resumesFromCursorAfterReconnect() {
        val fx = Fixtures.fresh(3)
        val seeder = Engine(MemoryStore())
        Fixtures.list(fx, "posts").forEach { seeder.accept(it, null) }
        val m = manager(seeder, internet = false)
        Fixtures.eventually(message = "seeded") { Fixtures.list(fx, "posts").all { seeder.delivered.contains(it.str("id")) } }
        m.shutdown()

        val store = MemoryStore()
        val phone = Engine(store)
        val m2 = manager(phone, internet = false)
        Fixtures.eventually(message = "first sync") { store.ids(System.currentTimeMillis(), 100).size == 3 }
        Fixtures.eventually(message = "cursor saved") { store.getMeta("hubcursor:http://127.0.0.1:$port") != null }
        m2.shutdown()
        assertTrue(store.getMeta("hubcursor:http://127.0.0.1:$port")!!.endsWith("|3"))
    }
}
