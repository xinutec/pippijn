package org.xinutec.coach

import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** The pacing verdict this reminder cares about. */
data class Verdict(val nudge: Boolean, val reason: String)

/**
 * Fetches GET /api/pacing/now, reusing the WebView's session cookie so the call
 * is authenticated without a separate token. Returns null on any failure (no
 * cookie yet, offline, non-200) — the caller just doesn't notify.
 *
 * Runs on a background thread (called from the geofence receiver's goAsync).
 */
object PacingClient {
    fun fetch(): Verdict? {
        val cookie = CookieManager.getInstance().getCookie(Config.BASE_URL) ?: return null
        return try {
            val conn =
                (URL("${Config.BASE_URL}/api/pacing/now").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    setRequestProperty("Cookie", cookie)
                    setRequestProperty("Accept", "application/json")
                    connectTimeout = 8000
                    readTimeout = 8000
                }
            if (conn.responseCode != 200) {
                conn.disconnect()
                return null
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val json = JSONObject(body)
            Verdict(
                nudge = json.optBoolean("nudge", false),
                reason = json.optString("reason", "Time to train"),
            )
        } catch (_: Exception) {
            null
        }
    }
}
