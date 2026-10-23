package com.feibixunchang.pagevault;

import android.app.Activity;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 热榜：从知乎 / V2EX / 掘金 / 少数派… 的榜单把文章抓下来存进库里。
 *
 * 抓取和抽正文都在服务端做，这里只发指令、看结果。
 */
public class HotListActivity extends Activity {

    private ListView list;
    private TextView status;
    private LinearLayout cookieBox;
    private EditText cookieInput;
    private final List<JSONObject> sources = new ArrayList<>();
    private String cookieDraft = "";
    private String cookieSourceId = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Prefs.applyTheme(this);
        super.onCreate(savedInstanceState);
        Api.init(this);
        setContentView(R.layout.activity_hotlist);

        list = findViewById(R.id.hotList);
        status = findViewById(R.id.hotStatus);
        cookieBox = findViewById(R.id.hotCookieBox);
        cookieInput = findViewById(R.id.hotCookieInput);

        findViewById(R.id.btnBack).setOnClickListener(v -> finish());
        findViewById(R.id.btnPullAll).setOnClickListener(v -> pullAll());

        list.setAdapter(new BaseAdapter() {
            @Override public int getCount() { return sources.size(); }
            @Override public Object getItem(int i) { return sources.get(i); }
            @Override public long getItemId(int i) { return i; }

            @Override
            public View getView(int position, View convertView, ViewGroup parent) {
                View v = convertView;
                if (v == null) {
                    v = LayoutInflater.from(HotListActivity.this).inflate(R.layout.item_hot, parent, false);
                }
                final JSONObject s = sources.get(position);
                TextView emoji = v.findViewById(R.id.emoji);
                TextView name = v.findViewById(R.id.name);
                TextView desc = v.findViewById(R.id.desc);
                Button pull = v.findViewById(R.id.pull);

                emoji.setText(s.optString("emoji", "📰"));
                name.setText(s.optString("name", ""));
                StringBuilder sb = new StringBuilder(s.optString("desc", ""));
                if (s.optBoolean("needsCookie", false)) {
                    sb.append(sb.length() > 0 ? " · " : "");
                    sb.append(s.optBoolean("hasCookie", false) ? "已配 Cookie" : "需要 Cookie");
                }
                JSONObject last = s.optJSONObject("lastResult");
                if (last != null) {
                    sb.append(" · 上次存了 ").append(last.optInt("saved", 0)).append(" 篇");
                }
                desc.setText(sb.toString());

                pull.setOnClickListener(x -> pull(s));
                return v;
            }
        });

        load();
    }

    private void load() {
        status.setText(R.string.loading);
        Api.async("GET", "/api/sources", null, r -> {
            if (!r.ok()) {
                status.setText(getString(R.string.load_fail, r.error != null ? r.error : ("HTTP " + r.code)));
                return;
            }
            try {
                JSONArray arr = new JSONArray(r.body);
                sources.clear();
                for (int i = 0; i < arr.length(); i++) sources.add(arr.getJSONObject(i));
                list.setAdapter(list.getAdapter());
                list.invalidateViews();
                status.setText(getString(R.string.hot_tip));
            } catch (Exception e) {
                status.setText(e.getMessage() == null ? "" : e.getMessage());
            }
        });
    }

    private void pull(final JSONObject s) {
        String id = s.optString("id");
        int limit = s.optInt("limit", 5);
        status.setText(getString(R.string.hot_pulling, s.optString("name", "")));
        Api.async("POST", "/api/sources/" + id + "/pull",
                new JSONObject().put("limit", limit).toString(),
                r -> {
                    if (!r.ok()) {
                        status.setText(getString(R.string.load_fail, r.error != null ? r.error : ("HTTP " + r.code)));
                        return;
                    }
                    try {
                        JSONObject d = new JSONObject(r.body);
                        int saved = d.getJSONArray("saved").length();
                        int skipped = d.getJSONArray("skipped").length();
                        JSONArray errs = d.getJSONArray("errors");
                        StringBuilder sb = new StringBuilder("存入 " + saved + " 篇");
                        if (skipped > 0) sb.append("，跳过 ").append(skipped).append(" 篇（多半已经收藏过）");
                        if (errs.length() > 0) {
                            sb.append("，失败 ").append(errs.length()).append(" 篇");
                            JSONObject e0 = errs.getJSONObject(0);
                            String em = e0.optString("error", "");
                            if (em.length() > 0) sb.append("：").append(em);
                        }
                        sb.append("，用时 ").append(d.optInt("durationMs", 0) / 1000).append(" 秒");
                        status.setText(sb.toString());
                        Toast.makeText(this, sb.toString(), Toast.LENGTH_LONG).show();
                    } catch (Exception e) {
                        status.setText(e.getMessage() == null ? "" : e.getMessage());
                    }
                    load();
                });
    }

    private void pullAll() {
        status.setText(R.string.hot_pulling_all);
        Api.async("POST", "/api/sources/pull-all", "{}", r -> {
            if (!r.ok()) {
                status.setText(getString(R.string.load_fail, r.error != null ? r.error : ("HTTP " + r.code)));
                return;
            }
            try {
                JSONObject d = new JSONObject(r.body);
                JSONArray results = d.getJSONArray("results");
                int saved = 0;
                for (int i = 0; i < results.length(); i++) {
                    saved += results.getJSONObject(i).getJSONArray("saved").length();
                }
                status.setText("全部拉取完成：存入 " + saved + " 篇");
                Toast.makeText(this, status.getText(), Toast.LENGTH_LONG).show();
            } catch (Exception e) {
                status.setText(e.getMessage() == null ? "" : e.getMessage());
            }
            load();
        });
    }
}
