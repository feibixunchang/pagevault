package com.feibixunchang.pagevault;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ImageButton;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 阅读页。
 *
 * - 原网页：直接显示服务端存的整页 HTML（图片走服务端的 /api/img 代理，离线也能看）
 * - 只读正文：用服务端的 readability.js 抽正文，去掉页头/侧栏/推荐流
 * - 字号 / 字体 / 粗体 直接注入 CSS，和桌面端、网页端共用同一套偏好
 */
public class ReaderActivity extends Activity {

    private WebView web;
    private TextView titleView;
    private ImageButton btnStar;
    private TextView btnMode;
    private String pageId, title;
    private boolean readerOn = false;
    private String rawHtml = "";
    private boolean starred = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Prefs.applyTheme(this);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_reader);

        pageId = getIntent().getStringExtra("id");
        title = getIntent().getStringExtra("title");
        if (title == null) title = "";

        web = findViewById(R.id.web);
        titleView = findViewById(R.id.title);
        btnStar = findViewById(R.id.btnStar);
        btnMode = findViewById(R.id.btnMode);
        titleView.setText(title);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        // 页面里的远程图片已经由服务端改写成 /api/img 代理，这里放行本地与 http
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                android.util.Log.i("PVJS", cm.messageLevel() + " " + cm.message()
                        + " @" + cm.lineNumber());
                return true;
            }
        });

        findViewById(R.id.btnBack).setOnClickListener(v -> finish());
        btnMode.setOnClickListener(v -> toggleMode());
        btnStar.setOnClickListener(v -> toggleStar());
        findViewById(R.id.btnText).setOnClickListener(v -> showTextOptions());

        loadPage();
    }

    private void loadPage() {
        final View loading = findViewById(R.id.loading);
        loading.setVisibility(View.VISIBLE);
        Api.async("GET", "/p/" + pageId, null, r -> {
            loading.setVisibility(View.GONE);
            if (!r.ok()) {
                Toast.makeText(this, getString(R.string.load_fail,
                        r.error != null ? r.error : ("HTTP " + r.code)), Toast.LENGTH_LONG).show();
                return;
            }
            rawHtml = r.body;
            showOriginal();
            if (Prefs.readerMode(this)) {
                // 默认开启正文模式：抽不到正文就退回原网页
                toggleMode();
            }
        });
    }

    private void showOriginal() {
        readerOn = false;
        btnMode.setText(R.string.reader_article);
        web.loadDataWithBaseURL(Prefs.serverUrl() + "/", rawHtml, "text/html", "utf-8", null);
    }

    /** 切换原网页 / 只读正文 */
    private void toggleMode() {
        if (readerOn) {
            showOriginal();
            return;
        }
        final View loading = findViewById(R.id.loading);
        loading.setVisibility(View.VISIBLE);
        Api.async("GET", "/readability.js", null, r -> {
            if (!r.ok()) {
                loading.setVisibility(View.GONE);
                Toast.makeText(this, getString(R.string.reader_fail, "HTTP " + r.code), Toast.LENGTH_LONG).show();
                return;
            }
            // 先把 readability.js 单独注入（它会定义 window.Readability），再跑抽取代码。
            // 分两步是为了 readability.js 万一有语法问题，也不会把我们的逻辑一起带崩。
            web.evaluateJavascript(r.body, r1 -> {
                final String extract = "(function(){try{"
                        + "var d=new DOMParser().parseFromString(document.documentElement.outerHTML,'text/html');"
                        + "var a=new Readability(d).parse();"
                        + "if(!a||!a.content){window.__pvErr='no-article';return 'ERR';}"
                        + "window.__pvArticle=a;return 'OK';}catch(e){"
                        + "window.__pvErr=String((e&&e.message)||e);return 'ERR';}})()";
                web.evaluateJavascript(extract, res -> {
                    if (res != null && res.contains("OK")) {
                        loading.setVisibility(View.GONE);
                        renderArticle();
                    } else {
                        loading.setVisibility(View.GONE);
                        web.evaluateJavascript("window.__pvErr||''", e2 -> {
                            final String detail = (e2 != null && e2.length() > 2)
                                    ? e2.substring(1, e2.length() - 1) : "解析失败";
                            Toast.makeText(ReaderActivity.this,
                                    getString(R.string.reader_not_article) + "（" + detail + "）",
                                    Toast.LENGTH_LONG).show();
                        });
                    }
                });
            });
        });
    }

    private void renderArticle() {
        final String css = buildReaderCss();
        // 整段 JS 放在字符串里，别让 Java 把 a.content 之类当成变量
        String js = "(function(){var a=window.__pvArticle;if(!a)return 'ERR';"
                + "var byline=a.byline?('<p class=\"rv-byline\">'+a.byline+'</p>'):'';"
                + "var css=__CSS__;"
                + "var t=String(a.title||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');"
                + "var html='<!DOCTYPE html><html class=\"rv-dark\"><head><meta charset=\"utf-8\">"
                + "<style>'+css+'</style></head>"
                + "<body><div class=\"rv-body\"><h1>'+t+'</h1>'+byline+a.content+'</div></body></html>';"
                + "document.open();document.write(html);document.close();return 'OK';})()";
        js = js.replace("__CSS__", q(css));
        web.evaluateJavascript(js, res -> {
            if (res != null && res.contains("OK")) {
                readerOn = true;
                btnMode.setText(R.string.reader_original);
            }
        });
    }

    private static String q(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "") + "\"";
    }

    /** 阅读样式：字号 / 字体 / 粗体 / 深浅色，和网页端保持一致 */
    private String buildReaderCss() {
        float px = Prefs.fontSizePx(this);
        boolean bold = Prefs.bold(this);
        int weight = bold ? 600 : 400;
        int titleWeight = bold ? 700 : 600;
        boolean dark = Prefs.isDark(this);
        String fontCss = Fonts.readerFontCss(this);
        String bg = dark ? "#131518" : "#ffffff";
        String fg = dark ? "#dde1e6" : "#1f2933";
        String muted = dark ? "#9aa3af" : "#6b7280";
        String link = dark ? "#6cb2f2" : "#185fa5";
        String code = dark ? "#23272f" : "#f4f5f7";
        String border = dark ? "#2e3340" : "#e3e6ea";
        return ":root{color-scheme:" + (dark ? "dark" : "light") + ";}\n"
                + "body{margin:0;background:" + bg + ";}\n"
                + ".rv-body{max-width:760px;margin:0 auto;padding:32px 20px;font-size:" + px + "px;line-height:1.85;color:" + fg
                + ";background:" + bg + ";font-weight:" + weight + ";}\n"
                + ".rv-body img,.rv-body video{max-width:100%;height:auto;border-radius:6px;}\n"
                + ".rv-body h1{font-size:1.45em;line-height:1.4;font-weight:" + titleWeight + ";}\n"
                + ".rv-body h2{font-size:1.2em;}\n"
                + ".rv-body h3{font-size:1.06em;}\n"
                + ".rv-body a{color:" + link + ";}\n"
                + ".rv-body pre{background:" + code + ";padding:12px;border-radius:8px;overflow:auto;}\n"
                + ".rv-body img{max-width:100%;}\n"
                + ".rv-byline{color:" + muted + ";font-size:.78em;margin:0 0 22px;padding-bottom:14px;border-bottom:1px solid " + border + ";}\n"
                + fontCss;
    }

    /** 原网页模式下也把字号/字体/粗体套上去 */
    private void applyPageStyle() {
        float px = Prefs.fontSizePx(this);
        boolean bold = Prefs.bold(this);
        String fontCss = Fonts.readerFontCss(this);
        String css = "html,body{font-size:" + px + "px !important;font-weight:" + (bold ? 600 : 400)
                + " !important;line-height:1.8 !important;}\n" + fontCss;
        web.evaluateJavascript("(function(){var st=document.getElementById('pv-style');if(!st){st=document.createElement('style');st.id='pv-style';document.head.appendChild(st);}st.textContent=" + q(css) + ";return 'OK';})()", null);
    }

    private void toggleStar() {
        Api.async("PATCH", "/api/pages/" + pageId + "/star", null, r -> {
            if (!r.ok()) {
                Toast.makeText(this, R.string.del_fail, Toast.LENGTH_SHORT).show();
                return;
            }
            try {
                starred = new org.json.JSONObject(r.body).optBoolean("starred", false);
                btnStar.setImageResource(starred ? R.drawable.ic_star_filled : R.drawable.ic_star);
            } catch (Exception ignored) { }
        });
    }

    /** 顶部「正文」按钮：调字号/粗体/字体 */
    private void showTextOptions() {
        final String[] sizes = {"s", "m", "l", "xl", "xxl"};
        final String[] sizeNames = {"15", "17", "19.5", "22", "24"};
        int cur = 1;
        for (int i = 0; i < sizes.length; i++) if (sizes[i].equals(Prefs.fontSize(this))) cur = i;
        new AlertDialog.Builder(this)
                .setTitle(R.string.settings_fontsize)
                .setSingleChoiceItems(sizeNames, cur, (d, which) -> {
                    Prefs.setFontSize(this, sizes[which]);
                    d.dismiss();
                    applyStyle();
                })
                .setNeutralButton(R.string.settings_bold, (d, w) -> {
                    Prefs.setBold(this, !Prefs.bold(this));
                    applyStyle();
                })
                .setNegativeButton(R.string.add_cancel, null)
                .show();
    }

    private void applyStyle() {
        if (readerOn) renderArticle();
        else applyPageStyle();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (web != null) {
            web.stopLoading();
            web.destroy();
        }
    }
}
