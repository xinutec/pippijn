package org.xinutec.vantage

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.content.edit
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * A full-screen [WebView] onto vantage — the fleet monitoring dashboard, an Angular
 * app served at [VANTAGE_URL]. No address bar, no tabs, a home-screen icon: the
 * status board presented as a native app, avoiding browser chrome. It's private
 * (reachable only over the VPN) with no login; the app needs only `INTERNET`.
 *
 * Deliberately tiny — a [ComponentActivity] holding one WebView, no Compose or
 * AppCompat. `configChanges` keeps the WebView (and its route + scroll) across
 * rotation.
 *
 * The WebView is inset from the system bars by padding a wrapper (see [onCreate]),
 * and the strips behind the bars are painted with the page's own surface colour.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var root: FrameLayout

    // Modern back handling (predictive back on API 33+, opted into via the
    // manifest's enableOnBackInvokedCallback). Enabled only while the SPA has
    // somewhere in-app to go, so at the root the system shows its own predictive
    // "exit to launcher" gesture instead.
    private val backCallback =
        object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) {
                    web.goBack()
                } else {
                    // Nothing left in-app: hand back to the system to finish.
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        }

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
                            if (url.startsWith(VANTAGE_URL)) {
                                prefs.edit { putString(KEY_LAST_URL, url) }
                            }
                            syncBackEnabled()
                        }

                        // Paint the strips behind the system bars with the web UI's
                        // own surface colour instead of a hardcoded black; it follows
                        // the page's light/dark theme, so read its body background.
                        override fun onPageFinished(view: WebView, url: String) {
                            super.onPageFinished(view, url)
                            view.evaluateJavascript(
                                "getComputedStyle(document.body).backgroundColor",
                            ) { result -> parseCssColor(result)?.let(root::setBackgroundColor) }
                        }
                    }
                // Black until the page loads and reports its surface colour; avoids
                // a white flash on launch.
                setBackgroundColor(Color.BLACK)
            }
        // Inset the WebView from the system bars by padding a wrapper ViewGroup
        // (WebView.setPadding() doesn't offset content under wide-viewport mode).
        // Once the WebView no longer underlaps the bars its env(safe-area-inset-*)
        // collapse to 0, so the page's own safe-area CSS adds nothing on top.
        root =
            FrameLayout(this).apply {
                addView(web)
                setBackgroundColor(Color.BLACK)
            }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, backCallback)
        // Reopen where we left off; the hardcoded URL is only the first-run default.
        web.loadUrl(prefs.getString(KEY_LAST_URL, null) ?: VANTAGE_URL)
    }

    /** Intercept back only while the SPA has somewhere in-app to go; otherwise let
     *  the system handle it (finish / predictive exit). */
    private fun syncBackEnabled() {
        backCallback.isEnabled = web.canGoBack()
    }

    // evaluateJavascript hands back the JSON-encoded result, e.g. the string
    // "rgb(18, 18, 18)" (with quotes) or "rgba(18, 18, 18, 1)". Pull out the RGB
    // triple; alpha is ignored (the surface is opaque). null if it can't be read.
    private fun parseCssColor(raw: String?): Int? {
        val m = raw?.let { Regex("""rgba?\((\d+),\s*(\d+),\s*(\d+)""").find(it) } ?: return null
        val (r, g, b) = m.destructured
        return Color.rgb(r.toInt(), g.toInt(), b.toInt())
    }

    companion object {
        // The vantage dashboard (HTTPS, VPN-only, no login).
        private const val VANTAGE_URL = "https://vantage.xinutec.org/"
        private const val KEY_LAST_URL = "last_url"
    }
}
