package io.github.CyberTimon.RapidRAW

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // 深色主题与浅色主题下状态栏/导航栏区域的安全边缘背景色，
  // 跟随系统深色模式，避免浅色模式下出现深色系统栏。
  private var safeMarginBackgroundColor = Color.rgb(24, 24, 24)
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val nightMode =
      resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    safeMarginBackgroundColor =
      if (nightMode) Color.rgb(24, 24, 24) else Color.rgb(245, 245, 245)

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

    webView.setBackgroundColor(safeMarginBackgroundColor)
    webView.fitsSystemWindows = true

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val webView = this@MainActivity.webView
        if (webView == null) {
          // WebView 尚未就绪（启动极早期）：无任何前端层级可退出，按标准行为退至后台
          this@MainActivity.moveTaskToBack(true)
          return
        }
        // JS 侧 __handleAndroidBack 返回 false 表示已无可退出层级（应用主页等），
        // 此时 moveTaskToBack 将应用退至后台（标准 Android 返回行为）；
        // 返回 true 表示事件已被消费（关闭弹窗/面板/返回图库等）。
        webView.evaluateJavascript(
          "(window.__handleAndroidBack ? (window.__handleAndroidBack() === false) : true) ? 'exit' : 'handled'",
          android.webkit.ValueCallback<String> { result ->
            if (result == "\"exit\"") {
              this@MainActivity.moveTaskToBack(true)
            }
          }
        )
      }
    })
  }
}
