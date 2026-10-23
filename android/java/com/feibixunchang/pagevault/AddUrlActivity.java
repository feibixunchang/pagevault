package com.feibixunchang.pagevault;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
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
