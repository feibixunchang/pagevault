package com.feibixunchang.pagevault;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * 手机上保存文章。
 *
 * 电脑上靠浏览器扩展抓整页 DOM，手机拿不到，所以换一条路：
 * 在微信/浏览器里复制链接，回到这里粘贴，服务端去抓这一页并存库。
 */
public class AddUrlActivity extends Activity {

    private EditText urlInput, titleInput;
    private TextView status;
    private View loading;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Prefs.applyTheme(this);
        super.onCreate(savedInstanceState);
        // 别指望 MainActivity 一定先跑过：进程被杀后系统恢复、或从「分享」直接进来时，
        // 这里要是没有 Api.init，请求会退回到写死的默认服务器地址，存的库不是用户配的那台。
        Api.init(this);
        setContentView(R.layout.activity_addurl);

        urlInput = findViewById(R.id.urlInput);
        titleInput = findViewById(R.id.titleInput);
        status = findViewById(R.id.status);
        loading = findViewById(R.id.loading);

        findViewById(R.id.btnCancel).setOnClickListener(v -> finish());
        findViewById(R.id.btnPaste).setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(this);
                if (t != null) urlInput.setText(t.toString().trim());
            }
        });
        findViewById(R.id.btnSave).setOnClickListener(v -> save());

        // 打开就自动聚焦并弹键盘，直接粘贴
        urlInput.requestFocus();

        // 从微信/浏览器「分享 → 网页收藏」进来：链接已经在 Intent 里了，直接存，
        // 不用用户再复制粘贴一遍。手机上没有扩展那套整页抓取，分享是最顺手的入口。
        String shared = sharedUrl(getIntent());
        if (shared != null) {
            urlInput.setText(shared);
            status.setText(R.string.share_saving);
            status.setVisibility(View.VISIBLE);
            save();
        }
    }

    /** 从 ACTION_SEND 的文本里抠出第一个 http(s) 链接；不是分享场景就返回 null */
    private static String sharedUrl(Intent it) {
        if (it == null || !Intent.ACTION_SEND.equals(it.getAction())) return null;
        String text = it.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) return null;
        // 分享文本常是「标题 + 链接」或带中文标点的一段话，只取链接本身
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("https?://[^\\s\"'<>，。、；：）】」]+")
                .matcher(text);
        return m.find() ? m.group() : null;
    }

    private void save() {
        String url = urlInput.getText().toString().trim();
        if (url.length() == 0) {
            Toast.makeText(this, R.string.add_no_url, Toast.LENGTH_SHORT).show();
            return;
        }
        if (!url.contains("://")) url = "https://" + url;
        final String title = titleInput.getText().toString();
        loading.setVisibility(View.VISIBLE);
        status.setText(R.string.add_fetching);
        status.setVisibility(View.VISIBLE);
        final String payload;
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("url", url);
            o.put("platform", "android");
            o.put("title", title == null ? "" : title);
            payload = o.toString();
        } catch (Exception e) {
            status.setText(e.getMessage() == null ? "" : e.getMessage());
            return;
        }
        Api.async("POST", "/api/pages/from-url", payload,
                r -> {
                    loading.setVisibility(View.GONE);
                    if (!r.ok()) {
                        String msg = r.error != null ? r.error : r.body;
                        try {
                            msg = new JSONObject(r.body).optString("error", msg);
                        } catch (Exception ignored) { }
                        status.setText(msg);
                        status.setVisibility(View.VISIBLE);
                        return;
                    }
                    try {
                        JSONObject o = new JSONObject(r.body);
                        status.setText(getString(R.string.add_saved) + "：" + o.optString("title", ""));
                    } catch (Exception e) {
                        status.setText(R.string.add_saved);
                    }
                    status.setVisibility(View.VISIBLE);
                    new android.os.Handler().postDelayed(() -> finish(), 900);
                });
    }
}
