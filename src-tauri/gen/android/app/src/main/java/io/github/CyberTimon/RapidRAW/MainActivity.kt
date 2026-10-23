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
      val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
      // 键盘弹出时窗口已由 adjustResize 收缩(WebView 高度减少)，无需再推 padding；
      // 非键盘场景底部 padding 恒为 0：WebView 全屏延伸至系统导航栏后方，
      // 底部避让改由前端容器读取 --android-inset-bottom 自行完成，
      // 避免 WebView 被收缩后底部露出 rootView 背景形成灰带(面板与屏幕底之间出现空隙)
      val bottomInset = if (imeVisible) 0 else systemBars.bottom
      injectBottomInset(bottomInset)

      view.setPadding(
        systemBars.left,
        systemBars.top,
        systemBars.right,
        0
      )

      insets
    }

    ViewCompat.requestApplyInsets(rootView)
  }

  // 将底部系统栏(导航栏/手势条)高度注入 WebView：CSS 变量驱动前端底部容器避让，
  // 使面板/底栏背景延伸到屏幕最底部，系统导航浮于其上(国内 App 标准形态)。
  // env(safe-area-inset-*) 在 Android WebView 恒为 0，必须经原生注入。
  private fun injectBottomInset(inset: Int) {
    val webView = this.webView ?: return
    webView.post {
      webView.evaluateJavascript(
        "(function(){try{document.documentElement.style.setProperty('--android-inset-bottom','${inset}px');" +
          "window.__androidBottomInset=${inset};}catch(e){}})()",
        null
      )
    }
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

    // 初始 inset 兜底注入：onCreate 阶段 WebView 未就绪、页面加载前 evaluateJavascript
    // 可能被丢弃，延迟到页面就绪后再补一次；后续 insets 变化由 listener 持续注入
    webView.postDelayed({
      val rootView: View = findViewById(android.R.id.content)
      val bars = androidx.core.view.ViewCompat.getRootWindowInsets(rootView)
        ?.getInsets(WindowInsetsCompat.Type.systemBars())
      injectBottomInset(bars?.bottom ?: 0)
    }, 800)
  }
}
