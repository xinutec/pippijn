package org.xinutec.home

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * A full-screen [WebView] onto the home environment dashboard — the Angular app
 * served at [HOME_URL]. No address bar, no tabs, a home-screen icon: the public
 * dashboard presented as an app, avoiding browser chrome.
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
                // Keep every navigation inside this WebView — never hand off to a browser.
                webViewClient = WebViewClient()
                // The page is dark; black avoids a white flash and fills the strips
                // behind the (transparent, edge-to-edge) system bars.
                setBackgroundColor(Color.BLACK)
            }
        setContentView(web)
        web.loadUrl(HOME_URL)
    }

    // Back walks the SPA's history; it only leaves the app once there's nothing
    // left to go back to.
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    companion object {
        // The public household-environment dashboard (HTTPS, no auth for reads).
        private const val HOME_URL = "https://home.xinutec.org/"
    }
}
