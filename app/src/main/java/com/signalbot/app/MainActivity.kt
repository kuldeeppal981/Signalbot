package com.signalbot.app

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
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
        private val allowedHosts = setOf(
            "api.upstox.com",
            "apiconnect.angelone.in",
            "apiconnect.angelbroking.com"
        )

        // Network calls run natively so there is no CORS. Only broker hosts are allowed.
        @JavascriptInterface
        fun fetch(id: String, method: String, url: String, headersJson: String, body: String) {
            Thread {
                var status = 0
                var out = ""
                try {
                    val u = URL(url)
                    if (u.protocol != "https" || u.host !in allowedHosts) throw IllegalArgumentException("blocked host")
                    val c = u.openConnection() as HttpURLConnection
                    c.requestMethod = method
                    c.connectTimeout = 15000
                    c.readTimeout = 20000
                    val h = JSONObject(headersJson)
                    h.keys().forEach { k -> c.setRequestProperty(k, h.getString(k)) }
                    if (method == "POST") {
                        c.doOutput = true
                        c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                    }
                    status = c.responseCode
                    val stream = if (status in 200..299) c.inputStream else c.errorStream
                    out = stream?.bufferedReader()?.use { it.readText() } ?: ""
                } catch (e: Exception) {
                    status = -1
                    out = e.message ?: "network error"
                }
                val b64 = Base64.encodeToString(out.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                runOnUiThread {
                    web.evaluateJavascript("window.__nativeCb('$id',$status,'$b64')", null)
                }
            }.start()
        }
    }
}
