package com.signalbot.app

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.addJavascriptInterface(Bridge(), "Native")
        web.loadUrl("file:///android_asset/index.html")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    inner class Bridge {
        // Only Upstox API calls are allowed. Token stays on the device.
        @JavascriptInterface
        fun request(id: String, url: String, token: String) {
            Thread {
                var status = 0
                var body = ""
                try {
                    if (!url.startsWith("https://api.upstox.com/")) throw IllegalArgumentException("blocked host")
                    val c = URL(url).openConnection() as HttpURLConnection
                    c.requestMethod = "GET"
                    c.connectTimeout = 15000
                    c.readTimeout = 20000
                    c.setRequestProperty("Accept", "application/json")
                    if (token.isNotEmpty()) c.setRequestProperty("Authorization", "Bearer $token")
                    status = c.responseCode
                    val stream = if (status in 200..299) c.inputStream else c.errorStream
                    body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                } catch (e: Exception) {
                    status = -1
                    body = e.message ?: "network error"
                }
                val b64 = Base64.encodeToString(body.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                runOnUiThread {
                    web.evaluateJavascript("window.__nativeCb('$id',$status,'$b64')", null)
                }
            }.start()
        }
    }
}
