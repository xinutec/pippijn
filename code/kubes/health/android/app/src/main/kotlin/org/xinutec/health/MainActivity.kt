package org.xinutec.health

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * A full-screen [WebView] onto the health dashboard — the Angular app served at
 * [HEALTH_URL]. No address bar, no tabs, a home-screen icon: the dashboard
 * presented as an app, avoiding browser chrome. The site is behind a login
 * (Nextcloud OAuth); the WebView keeps the session cookie, so it's a one-time
 * sign-in.
 *
 * Deliberately tiny — a plain Activity holding one WebView, no Compose/AppCompat.
 * `configChanges` keeps the WebView (and its route + scroll) across rotation.
 *
 * Edge-to-edge by design: the dashboard handles the system-bar insets itself via
 * CSS `env(safe-area-inset-*)` (viewport-fit=cover), so the wrapper adds no padding.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView

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
                // Keep every navigation inside this WebView — never hand off to a
                // browser — and remember the current in-app page so a cold reopen
                // returns to it (SPA route changes fire doUpdateVisitedHistory too).
                webViewClient =
                    object : WebViewClient() {
                        override fun doUpdateVisitedHistory(
                            view: WebView,
                            url: String,
                            isReload: Boolean,
                        ) {
                            super.doUpdateVisitedHistory(view, url, isReload)
                            if (url.startsWith(HEALTH_URL)) {
                                prefs.edit().putString(KEY_LAST_URL, url).apply()
                            }
                        }
                    }
                // The page is dark; black avoids a white flash and fills the strips
                // behind the (transparent, edge-to-edge) system bars.
                setBackgroundColor(Color.BLACK)
            }
        setContentView(web)
        // Reopen where we left off; the hardcoded URL is only the first-run default.
        web.loadUrl(prefs.getString(KEY_LAST_URL, null) ?: HEALTH_URL)
    }

    // Back walks the SPA's history; it only leaves the app once there's nothing
    // left to go back to.
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    companion object {
        // The health dashboard (HTTPS, behind a Nextcloud-OAuth login).
        private const val HEALTH_URL = "https://health.xinutec.org/"
        private const val KEY_LAST_URL = "last_url"
    }
}
