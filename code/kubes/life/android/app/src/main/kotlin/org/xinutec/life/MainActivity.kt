package org.xinutec.life

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * A full-screen [WebView] onto life — the personal home-OS app, an Angular SPA
 * served at [LIFE_URL]. No address bar, no tabs, a home-screen icon: the app
 * presented as a native one, avoiding browser chrome. It's behind a login
 * (Nextcloud identity); the WebView keeps the session cookie, so it's a one-time
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

    // A pending web camera request, held while the OS permission dialog is up.
    private var pendingCameraRequest: PermissionRequest? = null

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
                            if (url.startsWith(LIFE_URL)) {
                                prefs.edit().putString(KEY_LAST_URL, url).apply()
                            }
                        }
                    }
                // The barcode scanner calls getUserMedia; a WebView denies camera
                // access unless we explicitly grant it. Grant video capture, asking
                // the OS for the runtime CAMERA permission first if we lack it.
                webChromeClient =
                    object : WebChromeClient() {
                        // Mirror the web app's console to logcat (tag "life-web") so the
                        // in-WebView flow — e.g. the scanner's "[scan]" traces — is
                        // visible via `adb logcat -s life-web`.
                        override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                            Log.d("life-web", "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
                            return true
                        }

                        override fun onPermissionRequest(request: PermissionRequest) {
                            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE !in request.resources) {
                                request.deny()
                                return
                            }
                            if (hasCameraPermission()) {
                                request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                            } else {
                                pendingCameraRequest = request
                                requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_REQ)
                            }
                        }
                    }
                // The page is dark; black avoids a white flash and fills the strips
                // behind the (transparent, edge-to-edge) system bars.
                setBackgroundColor(Color.BLACK)
            }
        setContentView(web)
        // Reopen where we left off; the hardcoded URL is only the first-run default.
        web.loadUrl(prefs.getString(KEY_LAST_URL, null) ?: LIFE_URL)
    }

    // Back walks the SPA's history; it only leaves the app once there's nothing
    // left to go back to.
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    private fun hasCameraPermission() =
        checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    // Resolve the held web camera request once the user answers the OS dialog.
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != CAMERA_REQ) return
        val request = pendingCameraRequest ?: return
        pendingCameraRequest = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            request.deny()
        }
    }

    companion object {
        private const val CAMERA_REQ = 1
        // The life app (HTTPS, behind a Nextcloud-identity login).
        private const val LIFE_URL = "https://life.xinutec.org/"
        private const val KEY_LAST_URL = "last_url"
    }
}
