package org.spirchat.app

import android.content.Context
import android.util.Log
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * Phone-to-phone links over Google Nearby Connections (Bluetooth, BLE and Wi-Fi Direct, chosen
 * automatically). This layer only moves strings between phones: the sync protocol, validation
 * and encryption all live in the web app (web/src/lib/state.ts), which treats these links as peers.
 */
class Mesh(context: Context, private val listener: Listener) {

    interface Listener {
        fun onPeerConnected(endpointId: String)
        fun onPeerDisconnected(endpointId: String)
        fun onPeerMessage(endpointId: String, data: String)
        fun onMeshState(running: Boolean)
    }

    private val client: ConnectionsClient = Nearby.getConnectionsClient(context)
    private val connected = ConcurrentHashMap.newKeySet<String>()
    private val connecting = ConcurrentHashMap.newKeySet<String>()

    /** Random per-session name: reveals nothing about the user. */
    private val localName = "sc-" + (1..6).map { "abcdefghijkmnpqrstuvwxyz23456789".random() }.joinToString("")

    @Volatile
    var running = false
        private set

    private val strategy = Strategy.P2P_CLUSTER

    fun start() {
        if (running) return
        running = true
        client.startAdvertising(localName, SERVICE_ID, lifecycle, AdvertisingOptions.Builder().setStrategy(strategy).build())
            .addOnFailureListener { Log.w(TAG, "advertising failed", it) }
        client.startDiscovery(SERVICE_ID, discovery, DiscoveryOptions.Builder().setStrategy(strategy).build())
            .addOnFailureListener { Log.w(TAG, "discovery failed", it) }
        listener.onMeshState(true)
    }

    fun stop() {
        if (!running) return
        running = false
        client.stopAdvertising()
        client.stopDiscovery()
        client.stopAllEndpoints()
        connected.clear()
        connecting.clear()
        listener.onMeshState(false)
    }

    fun send(endpointId: String, data: String) {
        if (!connected.contains(endpointId)) return
        val bytes = data.toByteArray(Charsets.UTF_8)
        val payload =
            if (bytes.size <= ConnectionsClient.MAX_BYTES_DATA_SIZE) Payload.fromBytes(bytes)
            else Payload.fromStream(ByteArrayInputStream(bytes))
        client.sendPayload(endpointId, payload).addOnFailureListener { Log.w(TAG, "send failed", it) }
    }

    private val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            if (connected.contains(endpointId)) return
            // Only one side requests, so two phones never dial each other at the same moment.
            if (localName > info.endpointName) return
            if (!connecting.add(endpointId)) return
            client.requestConnection(localName, endpointId, lifecycle)
                .addOnFailureListener {
                    Log.w(TAG, "request to $endpointId failed", it)
                    connecting.remove(endpointId)
                }
        }

        override fun onEndpointLost(endpointId: String) {
            connecting.remove(endpointId)
        }
    }

    private val lifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            // Anyone may connect: envelopes are signed and validated, and private messages are
            // end-to-end encrypted, so a link only ever carries what is safe for a stranger to relay.
            client.acceptConnection(endpointId, payloads)
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            connecting.remove(endpointId)
            if (result.status.isSuccess) {
                connected.add(endpointId)
                listener.onPeerConnected(endpointId)
            }
        }

        override fun onDisconnected(endpointId: String) {
            connected.remove(endpointId)
            listener.onPeerDisconnected(endpointId)
        }
    }

    private val payloads = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            when (payload.type) {
                Payload.Type.BYTES -> payload.asBytes()?.let {
                    listener.onPeerMessage(endpointId, String(it, Charsets.UTF_8))
                }
                Payload.Type.STREAM -> {
                    val stream = payload.asStream()?.asInputStream() ?: return
                    thread(name = "mesh-read") {
                        try {
                            val bytes = stream.use { it.readBytes() }
                            listener.onPeerMessage(endpointId, String(bytes, Charsets.UTF_8))
                        } catch (e: Exception) {
                            Log.w(TAG, "stream from $endpointId failed", e)
                        }
                    }
                }
            }
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
    }

    companion object {
        private const val TAG = "SpirChatMesh"
        private const val SERVICE_ID = "org.spirchat.mesh.v1"
    }
}
