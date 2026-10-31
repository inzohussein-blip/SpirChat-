package org.spirchat.engine

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class PeerSyncTest {
    private lateinit var fx: Json.Obj

    @BeforeTest
    fun setUp() {
        org.junit.jupiter.api.Assumptions.assumeTrue(Fixtures.nodeAvailable(), "node is required")
        fx = Fixtures.fresh(3)
    }

    /** Connects two engines through an in-memory link, like two phones over Nearby. */
    private fun link(a: Engine, b: Engine): Pair<PeerSession, PeerSession> {
        lateinit var sa: PeerSession
        lateinit var sb: PeerSession
        sa = PeerSession(a, "b") { sb.receive(it) }
        sb = PeerSession(b, "a") { sa.receive(it) }
        sa.open()
        sb.open()
        return sa to sb
    }

    @Test
    fun phonesExchangeWhatTheOtherLacks() {
        val a = Engine(MemoryStore())
        val b = Engine(MemoryStore())
        val posts = Fixtures.list(fx, "posts")
        posts.take(2).forEach { assertIs<Accept.Added>(a.accept(it, null)) }
        assertIs<Accept.Added>(b.accept(fx.obj("sos")!!, null))

        link(a, b)
        for (e in listOf(a, b)) {
            assertTrue(e.store.contains(fx.obj("sos")!!.str("id")!!))
            posts.take(2).forEach { assertTrue(e.store.contains(it.str("id")!!)) }
        }
    }

    @Test
    fun newEnvelopesRelayAcrossAChainOfPhones() {
        val (a, b, c) = List(3) { Engine(MemoryStore()) }
        link(a, b)
        link(b, c)
        val dm = fx.obj("dm")!!
        assertIs<Accept.Added>(a.accept(dm, null))
        assertTrue(c.store.contains(dm.str("id")!!), "dm relayed a -> b -> c")
    }

    @Test
    fun invalidEnvelopesAreNotStoredOrRelayed() {
        val a = Engine(MemoryStore())
        val b = Engine(MemoryStore())
        val (_, sb) = link(a, b)
        val post = Fixtures.list(fx, "posts")[0]
        val forged = Json.Obj(post.fields + ("body" to Json.obj("room" to Json.str("test"), "text" to Json.str("forged"))))
        sb.receive(Json.obj("t" to Json.str("env"), "env" to forged).stringify())
        assertEquals(emptyList(), b.carriedIds())
        assertIs<Accept.Rejected>(b.accept(forged, null))
    }
}
