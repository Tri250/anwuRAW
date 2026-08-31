package io.github.CyberTimon.RapidRAW

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private val safeMarginBackgroundColor = Color.rgb(24, 24, 24)
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
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

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView

    // ===== Android 端首次安装语言默认简体中文 =====
    // 1. 设置 WebView locale (影响 Accept-Language header)
    webView.settings.setJavaScriptEnabled(true)
    webView.settings.javaScriptCanOpenWindowsAutomatically = true
    webView.settings.domStorageEnabled = true
    webView.settings.databaseEnabled = true
    webView.settings.allowFileAccess = true
    webView.settings.allowContentAccess = true
    webView.settings.useWideViewPort = true
    webView.settings.loadWithOverviewMode = true
    webView.settings.mediaPlaybackRequiresUserGesture = false
    webView.settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT

    // 2. 强制简体中文语言（覆盖系统 locale 影响）
    val zhLocale = java.util.Locale.SIMPLIFIED_CHINESE
    webView.settings.locale = zhLocale
    webView.language = "zh-CN"

    // 3. 设置 WebViewClient 在页面加载完成后注入默认语言 JS
    webView.webViewClient = object : WebViewClient() {
      override fun onPageFinished(view: WebView?, url: String?) {
        super.onPageFinished(view, url)
        // 注入默认简体中文逻辑：确保 localStorage i18n 持久化
        view?.evaluateJavascript(
          """
          (function() {
            try {
              // 强制 html lang 属性为 zh-CN
              if (document.documentElement.lang !== 'zh-CN') {
                document.documentElement.lang = 'zh-CN';
              }
              // 注入 window.__FORCE_ZH_CN 标记，让前端可以读取
              window.__FORCE_ZH_CN = true;
              // 延迟检查并注入 i18n 默认语言
              setTimeout(function() {
                try {
                  var settings = localStorage.getItem('app_settings');
                  if (settings) {
                    var parsed = JSON.parse(settings);
                    // 如果用户没有设置过语言，默认写入 zh-CN
                    if (!parsed.language) {
                      parsed.language = 'zh-CN';
                      localStorage.setItem('app_settings', JSON.stringify(parsed));
                      console.log('[anwuRAW] Android: 设置默认语言为 zh-CN');
                    }
                  } else {
                    // 首次安装，写入初始设置
                    var initialSettings = { language: 'zh-CN', theme: 'dark' };
                    localStorage.setItem('app_settings', JSON.stringify(initialSettings));
                    console.log('[anwuRAW] Android 首次安装: 初始化设置，默认语言 zh-CN');
                  }
                } catch(e) {
                  console.warn('[anwuRAW] settings 注入失败:', e);
                }
              }, 300);
            } catch(e) {
              console.warn('[anwuRAW] Android locale 注入失败:', e);
            }
          })();
          """.trimIndent(),
          null
        )
      }
    }

    webView.setBackgroundColor(safeMarginBackgroundColor)
    webView.fitsSystemWindows = true

    // 禁用双指缩放 / 确保触摸行为稳定
    webView.settings.setSupportZoom(false)
    webView.settings.builtInZoomControls = false
    webView.settings.displayZoomControls = false

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        this@MainActivity.webView?.evaluateJavascript("window.__handleAndroidBack()", null)
      }
    })
  }
}
