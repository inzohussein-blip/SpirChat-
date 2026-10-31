package org.spirchat.app

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Raises notifications for envelopes that arrive from elsewhere while the app is in the
 * background. Private messages are end-to-end encrypted and only the web UI holds the key,
 * so a DM notification says that a message arrived, not what it says.
 */
object Notifier {
    @Volatile var foreground = false
    private const val DM_ID = 100
    private const val URGENT_ID = 101
    private var installed = false

    @Synchronized
    fun install(context: Context) {
        if (installed) return
        installed = true
        val app = context.applicationContext
        SyncService.createChannels(app)
        Core.addEnvelopeListener { env, source ->
            if (source == null || foreground) return@addEnvelopeListener
            val myTag = Core.store.getMeta("myTag")
            when (env.str("kind")) {
                "dm" -> if (myTag != null && env.str("to") == myTag) {
                    show(app, DM_ID, SyncService.CHANNEL_MESSAGES, app.getString(R.string.notify_dm), null)
                }
                "sos" -> show(app, URGENT_ID, SyncService.CHANNEL_URGENT, app.getString(R.string.notify_sos), env.obj("body")?.str("text"))
                "alert" -> {
                    val official = (Core.store.getMeta("alertKeys") ?: "").split(',').contains(env.str("author"))
                    if (official) {
                        val body = env.obj("body")
                        show(app, URGENT_ID, SyncService.CHANNEL_URGENT, body?.str("title") ?: "", body?.str("text"))
                    }
                }
            }
        }
    }

    private fun show(context: Context, id: Int, channel: String, title: String, text: String?) {
        if (Build.VERSION.SDK_INT >= 33 && !Permissions.granted(context, Manifest.permission.POST_NOTIFICATIONS)) return
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(id, n)
        } catch (_: SecurityException) {
            // Notification permission revoked meanwhile.
        }
    }

    fun clear(context: Context) {
        context.getSystemService(NotificationManager::class.java).apply {
            cancel(DM_ID)
            cancel(URGENT_ID)
        }
    }
}
