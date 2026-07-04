package org.xinutec.coach

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource

/**
 * A full-screen [WebView] onto coach (the Angular app at [Config.BASE_URL]),
 * presented as a native app — no address bar, a home-screen icon, session cookie
 * kept for one-time Nextcloud sign-in.
 *
 * Plus a small "Reminders" button that sets up the native home geofence: it
 * records your home location on-device (never sent anywhere) and arms the
 * geofence so [GeofenceBroadcastReceiver] can nudge you to train when you're home.
 *
 * A plain Activity holding one WebView — no Compose/AppCompat. `configChanges`
 * keeps the WebView (route + scroll) across rotation.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var root: FrameLayout

    // Drives the multi-step permission → set-home → arm flow across the async
    // location fetch and the permission-result callbacks.
    private var setupInProgress = false
    private var notifAsked = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("viewer", Context.MODE_PRIVATE)
        web =
            WebView(this).apply {
                layoutParams =
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                settings.javaScriptEnabled = true // Angular needs JS
                settings.domStorageEnabled = true // localStorage / sessionStorage
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                // Keep coach (and its Nextcloud login hop) in this WebView; hand
                // every other origin to the real browser. Remember the current SPA
                // route so a cold reopen returns to it.
                webViewClient =
                    object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            view: WebView,
                            request: WebResourceRequest,
                        ): Boolean {
                            val url = request.url
                            if (url.scheme == "https" && url.host in Config.ALLOWED_HOSTS) {
                                return false // in-app
                            }
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, url))
                            } catch (_: ActivityNotFoundException) {
                                // No handler — drop the navigation.
                            }
                            return true
                        }

                        override fun doUpdateVisitedHistory(
                            view: WebView,
                            url: String,
                            isReload: Boolean,
                        ) {
                            super.doUpdateVisitedHistory(view, url, isReload)
                            if (url.startsWith(Config.BASE_URL)) {
                                prefs.edit().putString(KEY_LAST_URL, url).apply()
                            }
                        }

                        // Paint the strips behind the system bars with the page's own
                        // surface colour so it follows the app's light/dark theme.
                        override fun onPageFinished(view: WebView, url: String) {
                            super.onPageFinished(view, url)
                            view.evaluateJavascript(
                                "getComputedStyle(document.body).backgroundColor",
                            ) { result -> parseCssColor(result)?.let(root::setBackgroundColor) }
                        }
                    }
                webChromeClient =
                    object : WebChromeClient() {
                        // Mirror the web app's console to logcat (adb logcat -s coach-web).
                        override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                            Log.d(
                                "coach-web",
                                "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})",
                            )
                            return true
                        }
                    }
                setBackgroundColor(Color.BLACK) // avoid a white flash on launch
            }

        root =
            FrameLayout(this).apply {
                addView(web)
                setBackgroundColor(Color.BLACK)
            }

        // A subtle "Reminders" button over the WebView, bottom-left (the web app's
        // own FAB lives bottom-right), opening the native geofence setup.
        val reminders =
            Button(this).apply {
                text = getString(R.string.reminders)
                alpha = 0.85f
                setOnClickListener { showRemindersDialog() }
                layoutParams =
                    FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.WRAP_CONTENT,
                        FrameLayout.LayoutParams.WRAP_CONTENT,
                    ).apply {
                        gravity = Gravity.BOTTOM or Gravity.START
                        setMargins(dp(12), 0, 0, dp(12))
                    }
            }
        root.addView(reminders)

        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        web.loadUrl(prefs.getString(KEY_LAST_URL, null) ?: Config.BASE_URL)

        // Re-register the geofence if reminders were armed before (e.g. after an
        // app update). No-op if not armed / permissions missing.
        Geofencing.arm(this)
    }

    override fun onDestroy() {
        root.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    // ---- reminders / geofence setup ----

    private fun showRemindersDialog() {
        val prefs = Prefs(this)
        val status =
            (if (prefs.hasHome) "Home is set." else "Home not set yet.") +
                "\n" +
                (if (prefs.armed) "Reminders are ON." else "Reminders are OFF.")
        val builder =
            AlertDialog.Builder(this)
                .setTitle("Home reminders")
                .setMessage(
                    "$status\n\nYou'll get a nudge to train when you settle at home — but " +
                        "only when coach says it's a good moment (inside your window, not " +
                        "too soon after your last set).",
                )
                .setPositiveButton(
                    if (prefs.hasHome) "Update home & turn on" else "Use current location & turn on",
                ) { _, _ -> beginSetup() }
                .setNegativeButton("Close", null)
        if (prefs.armed) {
            builder.setNeutralButton("Turn off") { _, _ ->
                prefs.armed = false
                Geofencing.disarm(this)
                toast("Reminders off.")
            }
        }
        builder.show()
    }

    private fun beginSetup() {
        setupInProgress = true
        notifAsked = false
        continueSetup()
    }

    // Walk the prerequisites in order; each missing one is requested and the flow
    // resumes from onRequestPermissionsResult (or captureHome's callback).
    private fun continueSetup() {
        if (!setupInProgress) return
        if (!hasPerm(Manifest.permission.ACCESS_FINE_LOCATION)) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), REQ_FINE)
            return
        }
        if (!Prefs(this).hasHome) {
            captureHome()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            !hasPerm(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        ) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), REQ_BG)
            return
        }
        // Notifications: nice-to-have — if denied we still arm (the nudge just
        // won't show until enabled in settings), so ask at most once.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !hasPerm(Manifest.permission.POST_NOTIFICATIONS) &&
            !notifAsked
        ) {
            notifAsked = true
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
            return
        }

        val prefs = Prefs(this)
        prefs.armed = true
        val ok = Geofencing.arm(this)
        setupInProgress = false
        toast(if (ok) "Reminders on — I'll nudge you when you're home." else "Couldn't arm the geofence.")
    }

    @SuppressLint("MissingPermission") // FINE is checked in continueSetup before we get here
    private fun captureHome() {
        toast("Getting your location…")
        LocationServices.getFusedLocationProviderClient(this)
            .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, CancellationTokenSource().token)
            .addOnSuccessListener { loc ->
                if (loc != null) {
                    val prefs = Prefs(this)
                    prefs.homeLat = loc.latitude
                    prefs.homeLng = loc.longitude
                    toast("Home set to here.")
                    continueSetup()
                } else {
                    setupInProgress = false
                    toast("Couldn't get a location fix — try again near a window.")
                }
            }
            .addOnFailureListener {
                setupInProgress = false
                toast("Location unavailable.")
            }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        when (requestCode) {
            REQ_FINE ->
                if (granted) {
                    continueSetup()
                } else {
                    setupInProgress = false
                    toast("Location is needed to know when you're home.")
                }
            REQ_BG ->
                if (granted) {
                    continueSetup()
                } else {
                    setupInProgress = false
                    toast("Set location to \"Allow all the time\" for home reminders to work.")
                }
            // Notifications: proceed to arm whether or not it was granted.
            REQ_NOTIF -> continueSetup()
        }
    }

    private fun hasPerm(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_SHORT).show()

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // evaluateJavascript hands back the JSON-encoded result, e.g. "rgb(18, 18, 18)".
    // Pull out the RGB triple; alpha is ignored (the surface is opaque).
    private fun parseCssColor(raw: String?): Int? {
        val m = raw?.let { Regex("""rgba?\((\d+),\s*(\d+),\s*(\d+)""").find(it) } ?: return null
        val (r, g, b) = m.destructured
        return Color.rgb(r.toInt(), g.toInt(), b.toInt())
    }

    private companion object {
        const val REQ_FINE = 101
        const val REQ_BG = 102
        const val REQ_NOTIF = 103
        const val KEY_LAST_URL = "last_url"
    }
}
