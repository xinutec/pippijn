package org.xinutec.coach

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent

/**
 * Fired by Play Services when the home boundary is crossed. On a settle-at-home
 * (ENTER/DWELL) it asks the backend whether now is a good moment and posts a
 * reminder only if so — the backend already applies the window / night-cutoff /
 * spacing gates, so this stays a thin trigger.
 *
 * The work runs off a `goAsync()` background thread (a quick authenticated GET),
 * so no foreground service is needed.
 */
class GeofenceBroadcastReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent) ?: return
        if (event.hasError()) return
        val transition = event.geofenceTransition
        if (transition != Geofence.GEOFENCE_TRANSITION_ENTER &&
            transition != Geofence.GEOFENCE_TRANSITION_DWELL
        ) {
            return
        }

        val app = context.applicationContext
        val pending = goAsync()
        Thread {
            try {
                val verdict = PacingClient.fetch()
                if (verdict != null && verdict.nudge) {
                    Notifications.postNudge(app, verdict.reason)
                }
            } finally {
                pending.finish()
            }
        }.start()
    }
}
