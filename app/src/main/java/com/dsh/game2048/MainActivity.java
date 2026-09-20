package com.dsh.game2048;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 一个极简的外壳：全屏 WebView 加载内置在 assets 里的 2048 网页。
 *
 * 为什么不用 Capacitor / Cordova：这个游戏本来就是纯静态页面，
 * 不需要任何原生插件，直接用 WebView 可以做到零第三方依赖、APK 约 1MB、
 * 且完全离线（连网络权限都不申请）。
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/www/index.html";
    private static final String BG = "#0b1220";

    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor(BG));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);              // 最高分/比例/声音开关存在 localStorage，必须开
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);                   // 关掉缩放，避免双指误触把棋盘放大
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);                        // 不跟随系统字体大小，避免把布局撑坏
        s.setAllowFileAccess(false);               // 不访问设备文件；assets 仍可正常加载
        s.setAllowContentAccess(false);
        s.setBlockNetworkLoads(true);              // 彻底禁止网络请求，断网/飞行模式照常玩
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new WebViewClient()); // 页面内跳转留在 WebView 内

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);   // 调试版可用 chrome://inspect
        }

        setContentView(web);

        if (state == null) {
            web.loadUrl(START_URL);
        } else {
            web.restoreState(state);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    /** 切到后台时暂停 WebView：音乐会停、定时器不再空转，省电 */
    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        web = null;
        super.onDestroy();
    }
}
