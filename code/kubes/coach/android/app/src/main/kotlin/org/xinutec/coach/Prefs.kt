package org.xinutec.coach

import android.content.Context

/**
 * On-device settings for the home geofence. The home coordinates live here and
 * ONLY here — never in the app's source or on the server (that's the user's
 * location). SharedPreferences has no Double, so lat/lng are stored as the raw
 * bits of the Double.
 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("coach", Context.MODE_PRIVATE)

    var homeLat: Double?
        get() = if (sp.contains(K_LAT)) Double.fromBits(sp.getLong(K_LAT, 0)) else null
        set(v) = sp.edit().apply { if (v == null) remove(K_LAT) else putLong(K_LAT, v.toRawBits()) }.apply()

    var homeLng: Double?
        get() = if (sp.contains(K_LNG)) Double.fromBits(sp.getLong(K_LNG, 0)) else null
        set(v) = sp.edit().apply { if (v == null) remove(K_LNG) else putLong(K_LNG, v.toRawBits()) }.apply()

    /** Geofence radius in metres. 150 m covers a house + garden without firing
     *  from the street. */
    var radiusM: Float
        get() = sp.getFloat(K_RADIUS, 150f)
        set(v) = sp.edit().putFloat(K_RADIUS, v).apply()

    /** Whether the user has turned reminders on. */
    var armed: Boolean
        get() = sp.getBoolean(K_ARMED, false)
        set(v) = sp.edit().putBoolean(K_ARMED, v).apply()

    val hasHome: Boolean get() = homeLat != null && homeLng != null

    private companion object {
        const val K_LAT = "home_lat"
        const val K_LNG = "home_lng"
        const val K_RADIUS = "radius_m"
        const val K_ARMED = "armed"
    }
}
