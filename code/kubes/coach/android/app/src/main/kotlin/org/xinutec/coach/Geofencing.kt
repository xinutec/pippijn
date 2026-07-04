package org.xinutec.coach

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices

/**
 * Registers/removes the single "home" geofence. The OS wakes
 * [GeofenceBroadcastReceiver] when the boundary is crossed — the app itself
 * doesn't run in between, which is why this is far more battery-efficient than
 * polling location or pulling it from Nextcloud.
 */
object Geofencing {
    private const val REQUEST_ID = "home"

    fun hasBackgroundLocation(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    // Geofence PendingIntents must be MUTABLE — Play Services fills in the
    // transition extras the receiver reads.
    private fun pendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, GeofenceBroadcastReceiver::class.java)
        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /** (Re)register the home geofence. No-op (returns false) unless reminders are
     *  armed, a home is set, and background-location is granted. */
    @SuppressLint("MissingPermission")
    fun arm(context: Context): Boolean {
        val prefs = Prefs(context)
        if (!prefs.armed) return false
        val lat = prefs.homeLat ?: return false
        val lng = prefs.homeLng ?: return false
        if (!hasBackgroundLocation(context)) return false

        val geofence =
            Geofence.Builder()
                .setRequestId(REQUEST_ID)
                .setCircularRegion(lat, lng, prefs.radiusM)
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                // DWELL (with a 1-min loiter) means "settled at home", not just
                // passing the boundary — avoids a nudge when you walk past.
                .setTransitionTypes(
                    Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_DWELL,
                )
                .setLoiteringDelay(60_000)
                .build()

        val request =
            GeofencingRequest.Builder()
                // Fire immediately if we're already home when armed.
                .setInitialTrigger(
                    GeofencingRequest.INITIAL_TRIGGER_ENTER or GeofencingRequest.INITIAL_TRIGGER_DWELL,
                )
                .addGeofence(geofence)
                .build()

        LocationServices.getGeofencingClient(context).addGeofences(request, pendingIntent(context))
        return true
    }

    fun disarm(context: Context) {
        LocationServices.getGeofencingClient(context).removeGeofences(pendingIntent(context))
    }
}
