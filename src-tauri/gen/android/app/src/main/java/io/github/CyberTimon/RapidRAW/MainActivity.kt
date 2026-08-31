package io.github.CyberTimon.RapidRAW

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale

class MainActivity : TauriActivity() {
  private val safeMarginBackgroundColor = Color.rgb(24, 24, 24)
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    // ===== Android 端首次安装语言默认简体中文 =====
    // 在 super.onCreate 之前设置 Activity locale，确保 WebView 继承
    setLocale(Locale.SIMPLIFIED_CHINESE)

    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val rootView: View = findViewById(android.R.id.content)
    rootView.setBackgroundColor(safeMarginBackgroundColor)

    ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val bottomPadding = if (insets.isVisible(WindowInsetsCompat.Type.ime())) {
        ime.bottom
      } else {
        systemBars.bottom
      }

      view.setPadding(
        systemBars.left,
        systemBars.top,
        systemBars.right,
        bottomPadding
      )

      insets
    }

    ViewCompat.requestApplyInsets(rootView)
  }

  private fun setLocale(locale: Locale) {
    Locale.setDefault(locale)
    val config = Configuration(baseContext.resources.configuration)
    config.setLocale(locale)
    createConfigurationContext(config)
    @Suppress("DEPRECATION")
    baseContext.resources.updateConfiguration(config, baseContext.resources.displayMetrics)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView

    // ===== Android 交互链增强 =====
    webView.settings.javaScriptEnabled = true
    webView.settings.javaScriptCanOpenWindowsAutomatically = true
    webView.settings.domStorageEnabled = true
    webView.settings.databaseEnabled = true
    webView.settings.allowFileAccess = true
    webView.settings.allowContentAccess = true
    webView.settings.useWideViewPort = true
    webView.settings.loadWithOverviewMode = true
    webView.settings.mediaPlaybackRequiresUserGesture = false
    webView.settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT

    // 禁用双指缩放
    webView.settings.setSupportZoom(false)
    webView.settings.builtInZoomControls = false
    webView.settings.displayZoomControls = false

    // ===== WebViewClient: onPageFinished 注入默认语言 JS =====
    webView.webViewClient = object : WebViewClient() {
      override fun onPageFinished(view: WebView?, url: String?) {
        super.onPageFinished(view, url)
        view?.evaluateJavascript(
          """
          (function() {
            try {
              document.documentElement.lang = 'zh-CN';
              window.__FORCE_ZH_CN = true;
              setTimeout(function() {
                try {
                  var s = localStorage.getItem('app_settings');
                  if (s) {
                    var p = JSON.parse(s);
                    if (!p.language) { p.language = 'zh-CN'; localStorage.setItem('app_settings', JSON.stringify(p)); }
                  } else {
                    localStorage.setItem('app_settings', JSON.stringify({ language: 'zh-CN', theme: 'dark' }));
                  }
                } catch(e) {}
              }, 300);
            } catch(e) {}
          })();
          """.trimIndent(),
          null
        )
      }
    }

    webView.setBackgroundColor(safeMarginBackgroundColor)
    webView.fitsSystemWindows = true

    // ===== 返回键桥接 =====
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        this@MainActivity.webView?.evaluateJavascript("window.__handleAndroidBack()", null)
      }
    })
  }
}
