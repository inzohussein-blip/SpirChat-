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
    fun publicEnvelopesRelayAcrossAChainOfPhones() {
        val (a, b, c) = List(3) { Engine(MemoryStore()) }
        link(a, b)
        link(b, c)
        val sos = fx.obj("sos")!!
        assertIs<Accept.Added>(a.accept(sos, null))
        assertTrue(c.store.contains(sos.str("id")!!), "sos relayed a -> b -> c")
    }

    @Test
    fun privateMessagesAreNotPassedOnByRelayingPhones() {
        val (a, b, c) = List(3) { Engine(MemoryStore()) }
        link(a, b)
        link(b, c)
        val dm = fx.obj("dm")!!
        assertIs<Accept.Added>(a.accept(dm, null))
        assertTrue(b.store.contains(dm.str("id")!!), "author hands it to b")
        assertTrue(!c.store.contains(dm.str("id")!!), "b got it from a phone, so it waits for a hub or the recipient")
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

    @Test
    fun imagesAreFetchedFromANearbyPhoneOnRequest() {
        val a = Engine(MemoryStore())
        val b = Engine(MemoryStore())
        val bytes = "RIFF....WEBPVP8 fake".toByteArray()
        val id = B64u.encode(Protocol.sha256(bytes))
        assertTrue(a.putBlob(id, "image/webp", bytes))
        assertTrue(!a.putBlob(id, "image/webp", "tampered".toByteArray()) || a.store.getBlob(id)!!.second.contentEquals(bytes))
        link(a, b)
        assertTrue(!b.store.hasBlob(id), "images are not pushed unasked")
        b.requestBlob(id)
        assertTrue(b.store.getBlob(id)!!.second.contentEquals(bytes))
    }

    @Test
    fun privateMessagesReachOnlyALimitedNumberOfNearbyPhones() {
        val origin = Engine(MemoryStore())
        val dm = fx.obj("dm")!!
        assertIs<Accept.Added>(origin.accept(dm, null))
        val reached = (1..10).count {
            val phone = Engine(MemoryStore())
            link(origin, phone)
            phone.store.contains(dm.str("id")!!)
        }
        assertEquals(Engine.OWN_DM_COPIES, reached)
    }

    @Test
    fun identicalPhonesExchangeOnlySummaries() {
        val a = Engine(MemoryStore())
        val b = Engine(MemoryStore())
        Fixtures.list(fx, "posts").forEach {
            a.accept(it, null)
            b.accept(it, null)
        }
        val sent = mutableListOf<String>()
        lateinit var sa: PeerSession
        lateinit var sb: PeerSession
        sa = PeerSession(a, "b") { sent += it; sb.receive(it) }
        sb = PeerSession(b, "a") { sent += it; sa.receive(it) }
        sa.open()
        sb.open()
        assertEquals(listOf("sum", "sum"), sent.map { (Json.parse(it) as Json.Obj).str("t") })
    }
}
