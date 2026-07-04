package org.xinutec.coach

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/** The single "time to train" reminder channel + poster. */
object Notifications {
    private const val CHANNEL = "coach-nudge"
    private const val NUDGE_ID = 1

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel =
                NotificationChannel(
                    CHANNEL,
                    "Training reminders",
                    NotificationManager.IMPORTANCE_DEFAULT,
                )
            channel.description = "Nudges you to spread your sets through the day, while you're home."
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    fun postNudge(context: Context, text: String) {
        ensureChannel(context)
        val launch =
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
        val pending =
            PendingIntent.getActivity(
                context,
                0,
                launch,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val notification =
            NotificationCompat
                .Builder(context, CHANNEL)
                .setContentTitle("Time to train")
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setSmallIcon(R.drawable.ic_stat_coach)
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()
        context.getSystemService(NotificationManager::class.java).notify(NUDGE_ID, notification)
    }
}
