package org.xinutec.coach

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Geofences don't survive a reboot — re-register the home geofence if reminders
 *  are armed (Geofencing.arm is a no-op otherwise). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Geofencing.arm(context.applicationContext)
    }
}
