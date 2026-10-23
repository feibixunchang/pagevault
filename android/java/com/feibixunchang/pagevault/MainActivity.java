package com.feibixunchang.pagevault;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 列表页：搜索、收藏筛选、点开阅读、＋粘贴链接保存、设置入口。
 *
 * 这里用 ScrollView + 手动填充条目，而不是 ListView + Adapter：
 * 实测 ListView.setOnItemClickListener 在这台设备上收不到点击（滚动正常、条目里的
 * 按钮也正常，就是 onItemClick 不触发），改成绑条目根视图也一样收不到触摸。
 * 自己填视图最直白，条目量本来也不大（几百条以内毫无压力）。
 */
public class MainActivity extends Activity {

    private LinearLayout listBox;
    private EditText search;
    private TextView tabAll, tabStar, emptyView;
    private JSONArray all = new JSONArray();
    private final List<JSONObject> shown = new ArrayList<>();
    private String keyword = "";
    private boolean onlyStarred = false;
    private SimpleDateFormat df;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Prefs.applyTheme(this);
        super.onCreate(savedInstanceState);
        Api.init(this);
        setContentView(R.layout.activity_main);
        df = new SimpleDateFormat("yyyy/MM/dd HH:mm", Locale.getDefault());

        listBox = findViewById(R.id.listBox);
        search = findViewById(R.id.search);
        tabAll = findViewById(R.id.tabAll);
        tabStar = findViewById(R.id.tabStar);
        emptyView = findViewById(R.id.empty);

        findViewById(R.id.btnAdd).setOnClickListener(v ->
                startActivity(new Intent(this, AddUrlActivity.class)));
        findViewById(R.id.btnSettings).setOnClickListener(v ->
                startActivity(new Intent(this, SettingsActivity.class)));
        findViewById(R.id.btnRefresh).setOnClickListener(v -> load());

        tabAll.setOnClickListener(v -> { onlyStarred = false; render(); });
        tabStar.setOnClickListener(v -> { onlyStarred = true; render(); });

        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override
            public void afterTextChanged(Editable s) {
                keyword = s.toString().trim();
                render();
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        load();
    }

    private void load() {
        final View bar = findViewById(R.id.loadingBar);
        bar.setVisibility(View.VISIBLE);
        Api.async("GET", "/api/pages", null, r -> {
            bar.setVisibility(View.GONE);
            if (!r.ok()) {
                Toast.makeText(MainActivity.this,
                        getString(R.string.load_fail, r.error != null ? r.error : ("HTTP " + r.code)),
                        Toast.LENGTH_LONG).show();
                return;
            }
            try {
                all = new JSONArray(r.body);
            } catch (Exception e) {
                all = new JSONArray();
            }
            render();
        });
    }

    private int starCount() {
        int n = 0;
        for (int i = 0; i < all.length(); i++) {
            JSONObject o = all.optJSONObject(i);
            if (o != null && o.optBoolean("starred", false)) n++;
        }
        return n;
    }

    /** 过滤 + 重新填充列表。 */
    private void render() {
        tabAll.setText(getString(R.string.tab_all, all.length()));
        tabStar.setText(getString(R.string.tab_star, starCount()));

        shown.clear();
        String kw = keyword.toLowerCase(Locale.getDefault());
        for (int i = 0; i < all.length(); i++) {
            JSONObject o = all.optJSONObject(i);
            if (o == null) continue;
            if (onlyStarred && !o.optBoolean("starred", false)) continue;
            if (!kw.isEmpty()) {
                String t = o.optString("title", "").toLowerCase(Locale.getDefault());
                String u = o.optString("url", "").toLowerCase(Locale.getDefault());
                if (!t.contains(kw) && !u.contains(kw)) continue;
            }
            shown.add(o);
        }

        listBox.removeAllViews();
        LayoutInflater inf = LayoutInflater.from(this);
        for (JSONObject o : shown) {
            View v = inf.inflate(R.layout.item_page, listBox, false);
            bindItem(v, o);
            listBox.addView(v);
        }
        boolean empty = shown.isEmpty();
        emptyView.setVisibility(empty ? View.VISIBLE : View.GONE);
        listBox.setVisibility(empty ? View.GONE : View.VISIBLE);
    }

    private void bindItem(View v, final JSONObject o) {
        TextView title = v.findViewById(R.id.title);
        TextView meta = v.findViewById(R.id.meta);
        TextView size = v.findViewById(R.id.size);
        ImageButton star = v.findViewById(R.id.star);

        title.setText(o.optString("title", "(无标题)"));
        String plat = o.optString("platform", "unknown");
        String src = hostOf(o.optString("url", ""));
        String date = o.optString("savedAt", "");
        String dateText = "";
        try {
            dateText = df.format(new Date(date));
        } catch (Exception ignored) { }
        meta.setText(plat + " · " + src + (dateText.isEmpty() ? "" : " · " + dateText));

        long bytes = o.optLong("size", 0);
        size.setText(bytes >= 1024 * 1024
                ? getString(R.string.size_mb, bytes / 1024.0 / 1024.0)
                : getString(R.string.size_kb, bytes / 1024));

        v.setOnClickListener(x -> {
            Intent it = new Intent(MainActivity.this, ReaderActivity.class);
            it.putExtra("id", o.optString("id"));
            it.putExtra("title", o.optString("title"));
            startActivity(it);
        });
        v.setOnLongClickListener(x -> {
            confirmDelete(o);
            return true;
        });

        star.setImageResource(o.optBoolean("starred", false) ? R.drawable.ic_star_filled : R.drawable.ic_star);
        star.setOnClickListener(x -> {
            String id = o.optString("id");
            Api.async("PATCH", "/api/pages/" + id + "/star", null, r -> {
                if (!r.ok()) {
                    Toast.makeText(MainActivity.this, R.string.del_fail, Toast.LENGTH_SHORT).show();
                    return;
                }
                try {
                    boolean starred = new JSONObject(r.body).optBoolean("starred", false);
                    o.put("starred", starred);
                    star.setImageResource(starred ? R.drawable.ic_star_filled : R.drawable.ic_star);
                    tabStar.setText(getString(R.string.tab_star, starCount()));
                } catch (Exception ignored) { }
            });
        });
    }

    private void confirmDelete(JSONObject o) {
        new AlertDialog.Builder(this)
                .setMessage(R.string.confirm_del)
                .setNegativeButton(R.string.add_cancel, null)
                .setPositiveButton(R.string.del_ok, (d, w) -> {
                    String id = o.optString("id");
                    Api.async("DELETE", "/api/pages/" + id, null, r -> {
                        if (r.ok()) {
                            Toast.makeText(MainActivity.this, R.string.del_ok, Toast.LENGTH_SHORT).show();
                            load();
                        } else {
                            Toast.makeText(MainActivity.this, R.string.del_fail, Toast.LENGTH_SHORT).show();
                        }
                    });
                })
                .show();
    }

    static String hostOf(String url) {
        try {
            String s = url;
            int i = s.indexOf("://");
            if (i >= 0) s = s.substring(i + 3);
            int slash = s.indexOf('/');
            if (slash > 0) s = s.substring(0, slash);
            return s;
        } catch (Exception e) {
            return url;
        }
    }
}
