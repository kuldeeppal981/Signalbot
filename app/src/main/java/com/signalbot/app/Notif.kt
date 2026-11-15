package com.signalbot.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

object Notif {
    const val CH_SCAN = "scan"
    const val CH_SIG = "signals"

    fun ensureChannels(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_SCAN, "Auto-scan status", NotificationManager.IMPORTANCE_LOW))
        val sig = NotificationChannel(CH_SIG, "Trade signals", NotificationManager.IMPORTANCE_HIGH)
        sig.enableVibration(true)
        nm.createNotificationChannel(sig)
    }

    fun openApp(c: Context): PendingIntent {
        val i = Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun scanNotification(c: Context): Notification =
        Notification.Builder(c, CH_SCAN)
            .setSmallIcon(android.R.drawable.ic_menu_search)
            .setContentTitle("SignalBot auto-scan chalu")
            .setContentText("Market hours mein signal dhoondh raha hai")
            .setContentIntent(openApp(c))
            .setOngoing(true)
            .build()

    fun signal(c: Context, title: String, text: String) {
        ensureChannels(c)
        val n = Notification.Builder(c, CH_SIG)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(openApp(c))
            .setAutoCancel(true)
            .build()
        c.getSystemService(NotificationManager::class.java).notify((System.currentTimeMillis() % 100000).toInt() + 10, n)
    }
}
