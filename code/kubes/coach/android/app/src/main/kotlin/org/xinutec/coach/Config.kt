package org.xinutec.coach

/** App-wide constants. */
object Config {
    /** The coach web app (HTTPS, behind Nextcloud-identity login). */
    const val BASE_URL = "https://coach.xinutec.org"

    /** Hosts allowed to load inside the WebView: the app + the Nextcloud login
     *  hop. Everything else opens in the real browser. */
    val ALLOWED_HOSTS = setOf("coach.xinutec.org", "dash.xinutec.org")
}
