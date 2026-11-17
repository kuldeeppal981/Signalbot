package com.signalbot.app

import android.annotation.SuppressLint
import android.app.Activity
import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
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
        Notif.ensureChannels(this)
    }

    // Back keeps the app running in the background (auto-scan needs the page alive).
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        moveTaskToBack(true)
    }

    inner class Bridge {
        private val allowedHosts = setOf(
            "api.upstox.com",
            "apiconnect.angelone.in",
            "apiconnect.angelbroking.com",
            "api.anthropic.com",
            "generativelanguage.googleapis.com"
        )

        @JavascriptInterface
        fun startScan() {
            runOnUiThread {
                try { startForegroundService(Intent(this@MainActivity, ScanService::class.java)) } catch (e: Exception) { }
            }
        }

        @JavascriptInterface
        fun stopScan() {
            runOnUiThread { stopService(Intent(this@MainActivity, ScanService::class.java)) }
        }

        @JavascriptInterface
        fun notify(title: String, text: String) {
            Notif.signal(this@MainActivity, title, text)
        }

        @JavascriptInterface
        fun askPermissions() {
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            }
        }

        @JavascriptInterface
        fun batterySettings() {
            runOnUiThread {
                try {
                    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }
        }

        // Network calls run natively so there is no CORS. Only broker hosts are allowed.
        @JavascriptInterface
        fun fetch(id: String, method: String, url: String, headersJson: String, body: String) {
            Thread {
                var status = 0
                var out = ""
                try {
                    val u = URL(url)
                    if (u.protocol != "https" || (u.host !in allowedHosts && !u.host.endsWith(".supabase.co"))) throw IllegalArgumentException("blocked host")
                    val c = u.openConnection() as HttpURLConnection
                    c.requestMethod = method
                    c.connectTimeout = 15000
                    c.readTimeout = if (method == "POST") 70000 else 20000
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
