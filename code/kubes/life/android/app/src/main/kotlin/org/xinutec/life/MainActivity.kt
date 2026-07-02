package org.xinutec.life

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

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
 * The WebView is inset from the system bars by padding a wrapper (see onCreate),
 * and the strips behind the bars are painted with the page's own surface colour.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var root: FrameLayout

    // A pending web camera request, held while the OS permission dialog is up.
    private var pendingCameraRequest: PermissionRequest? = null

    // A pending <input type=file> result callback, held while the picker is open.
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

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
                // Expose the system clipboard's image to the web app (its "Paste
                // copied image" action — e.g. an image copied in Chrome). The
                // bridge object is attached to the WebView as a whole, so every
                // call re-checks that the *current page* is the life app (see
                // readClipboardImageDataUrl) — a foreign page can't read the
                // clipboard even if it somehow ends up in this view.
                addJavascriptInterface(ClipboardImageBridge(), "AndroidClipboard")
                // Keep life (and its Nextcloud login hop) inside this WebView;
                // hand every other origin to the real browser. A chromeless view
                // has no URL bar, so an external link opening in-place would look
                // like the app — confine navigation instead. Also remember the
                // current in-app page so a cold reopen returns to it (SPA route
                // changes fire doUpdateVisitedHistory too).
                webViewClient =
                    object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            view: WebView,
                            request: WebResourceRequest,
                        ): Boolean {
                            val url = request.url
                            if (url.scheme == "https" && url.host in ALLOWED_HOSTS) {
                                return false // in-app
                            }
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, url))
                            } catch (_: ActivityNotFoundException) {
                                // No handler for this URL — drop the navigation.
                            }
                            return true
                        }

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

                        // A WebView ignores <input type=file> unless we launch the
                        // picker ourselves and hand the chosen URIs back — without
                        // this, tapping the app's image picker does nothing (it works
                        // in Chrome, which supplies its own file dialog). The intent
                        // from createIntent() honours the input's `accept` (image/*)
                        // and `multiple`, so it opens straight to the photo picker.
                        override fun onShowFileChooser(
                            webView: WebView,
                            filePathCallback: ValueCallback<Array<Uri>>,
                            fileChooserParams: FileChooserParams,
                        ): Boolean {
                            // Abandon any earlier pick that never resolved.
                            fileChooserCallback?.onReceiveValue(null)
                            fileChooserCallback = filePathCallback
                            return try {
                                startActivityForResult(fileChooserParams.createIntent(), FILE_REQ)
                                true
                            } catch (_: ActivityNotFoundException) {
                                fileChooserCallback = null
                                false // let the WebView know no chooser was shown
                            }
                        }
                    }
                // Black until the page loads and reports its surface colour; avoids a
                // white flash on launch.
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
        // Reopen where we left off; the hardcoded URL is only the first-run default.
        web.loadUrl(prefs.getString(KEY_LAST_URL, null) ?: LIFE_URL)
    }

    // `configChanges` keeps the Activity across rotation, so this only fires on a
    // real finish — release the WebView instead of leaking it.
    override fun onDestroy() {
        root.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    // Back walks the SPA's history; it only leaves the app once there's nothing
    // left to go back to.
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    // Deliver the picked image URIs back to the waiting <input type=file>. The
    // callback MUST be answered even on cancel (null), or the input stays blocked
    // and won't reopen the picker on the next tap.
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != FILE_REQ) return
        val callback = fileChooserCallback ?: return
        fileChooserCallback = null
        callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
    }

    private fun hasCameraPermission() =
        checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    /**
     * Bridge for the web app's "Paste copied image": returns the image on the
     * system clipboard as a `data:` URL, or null if there's no image. A WebView
     * can't read a clipboard image itself, so the page asks us. Reading happens
     * on the UI thread (ClipboardManager requires it) even though @JavascriptInterface
     * calls arrive on a binder thread.
     */
    inner class ClipboardImageBridge {
        @JavascriptInterface
        fun readImage(): String? {
            val task = FutureTask { readClipboardImageDataUrl() }
            runOnUiThread(task)
            return try {
                task.get(2, TimeUnit.SECONDS)
            } catch (_: Exception) {
                null
            }
        }
    }

    private fun readClipboardImageDataUrl(): String? {
        // Origin gate (runs on the UI thread, so web.url is safe to read): only
        // the life app itself may read the clipboard — not the NC login page,
        // and not any page that might slip past navigation confinement.
        if (web.url?.startsWith(LIFE_URL) != true) return null
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = clipboard.primaryClip ?: return null
        for (i in 0 until clip.itemCount) {
            val uri = clip.getItemAt(i).uri ?: continue
            val mime = contentResolver.getType(uri)?.takeIf { it.startsWith("image/") } ?: continue
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: continue
            if (bytes.size > MAX_PASTE_BYTES) return null // let the backend cap stand
            return "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        }
        return null
    }

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

    // evaluateJavascript hands back the JSON-encoded result, e.g. the string
    // "rgb(18, 18, 18)" (with quotes) or "rgba(18, 18, 18, 1)". Pull out the RGB
    // triple; alpha is ignored (the surface is opaque). null if it can't be read.
    private fun parseCssColor(raw: String?): Int? {
        val m = raw?.let { Regex("""rgba?\((\d+),\s*(\d+),\s*(\d+)""").find(it) } ?: return null
        val (r, g, b) = m.destructured
        return Color.rgb(r.toInt(), g.toInt(), b.toInt())
    }

    companion object {
        private const val CAMERA_REQ = 1
        private const val FILE_REQ = 2
        // Skip pasting anything larger than the backend's 5 MiB image cap.
        private const val MAX_PASTE_BYTES = 5 * 1024 * 1024
        // The life app (HTTPS, behind a Nextcloud-identity login).
        private const val LIFE_URL = "https://life.xinutec.org/"
        // Hosts allowed to load inside this WebView: the app itself plus the
        // Nextcloud login hop. Everything else goes to the real browser.
        private val ALLOWED_HOSTS = setOf("life.xinutec.org", "dash.xinutec.org")
        private const val KEY_LAST_URL = "last_url"
    }
}
