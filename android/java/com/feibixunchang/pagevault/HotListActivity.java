package com.feibixunchang.pagevault;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.text.InputType;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
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
 * 需要登录态的来源（知乎）在列表里**长按**该行填 Cookie。
 */
public class HotListActivity extends Activity {

    /** 拉一篇/拉全部要服务端去抓十几篇原文，90 秒的默认读超时根本不够 */
    private static final int PULL_TIMEOUT_MS = 300000;
    private static final int PULL_ALL_TIMEOUT_MS = 900000;

    private ListView list;
    private TextView status;
    private final List<JSONObject> sources = new ArrayList<>();
    /** 这次会话里粘过的 Cookie，重新打开弹窗时省得再复制一遍 */
    private String cookieDraft = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Prefs.applyTheme(this);
        super.onCreate(savedInstanceState);
        Api.init(this);
        setContentView(R.layout.activity_hotlist);

        list = findViewById(R.id.hotList);
        status = findViewById(R.id.hotStatus);

        findViewById(R.id.btnBack).setOnClickListener(v -> finish());
        findViewById(R.id.btnPullAll).setOnClickListener(v -> pullAll());

        list.setAdapter(new BaseAdapter() {
            @Override public int getCount() { return sources.size(); }
            @Override public Object getItem(int i) { return i < sources.size() ? sources.get(i) : null; }
            @Override public long getItemId(int i) { return i; }

            @Override
            public View getView(int position, View convertView, ViewGroup parent) {
                // 列表刷新时可能正在渲染，这里防一手越界
                if (position >= sources.size()) return convertView;
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
                boolean on = s.optBoolean("enabled", true);
                StringBuilder sb = new StringBuilder();
                if (!on) sb.append("已停用 · ");
                sb.append(s.optString("desc", ""));
                boolean needsCookie = s.optBoolean("needsCookie", false);
                boolean hasCookie = s.optBoolean("hasCookie", false);
                if (needsCookie) {
                    sb.append(sb.length() > 0 ? " · " : "");
                    sb.append(hasCookie ? "已配 Cookie" : "需要 Cookie（长按这里填写）");
                }
                JSONObject last = s.optJSONObject("lastResult");
                if (last != null) {
                    sb.append(" · 上次存了 ").append(last.optInt("saved", 0)).append(" 篇");
                }
                desc.setText(sb.toString());

                // 停用的来源不参与「全部拉取」和定时任务，按钮也一并禁掉，
                // 免得点下去报个看不懂的错
                pull.setEnabled(on);
                pull.setAlpha(on ? 1f : 0.4f);
                pull.setOnClickListener(x -> pull(s));
                return v;
            }
        });

        // 长按 = 这个来源的设置：启用/停用、每次几篇、填 Cookie。
        // 做成弹窗而不是在行里塞输入框：列表项是 ListView 复用的，塞 EditText 会跟着滚动串内容。
        list.setOnItemLongClickListener((parent, view, position, id) -> {
            if (position >= sources.size()) return false;
            showSourceMenu(sources.get(position));
            return true;
        });

        load(false);
    }

    /** 长按出来的菜单：以前只有「有 Cookie 的来源」能长按，别的来源在手机端完全没法配置 */
    private void showSourceMenu(final JSONObject s) {
        final boolean on = s.optBoolean("enabled", true);
        final boolean needsCookie = s.optBoolean("needsCookie", false);
        final List<String> items = new ArrayList<>();
        items.add(on ? "停用这个来源" : "启用这个来源");
        items.add("每次拉多少篇（当前 " + s.optInt("limit", 5) + " 篇）");
        if (needsCookie) items.add(s.optBoolean("hasCookie", false) ? "更换 Cookie" : "填写 Cookie");

        new AlertDialog.Builder(this)
                .setTitle(s.optString("name", ""))
                .setItems(items.toArray(new String[0]), (d, which) -> {
                    if (which == 0) putSource(s, "enabled", !on);
                    else if (which == 1) showLimitDialog(s);
                    else showCookieDialog(s);
                })
                .setNegativeButton(R.string.add_cancel, null)
                .show();
    }

    private void showLimitDialog(final JSONObject s) {
        final int[] opts = {3, 5, 8, 10, 15};
        int cur = s.optInt("limit", 5);
        int idx = 1;
        for (int i = 0; i < opts.length; i++) if (opts[i] == cur) idx = i;
        String[] labels = new String[opts.length];
        for (int i = 0; i < opts.length; i++) labels[i] = opts[i] + " 篇";
        new AlertDialog.Builder(this)
                .setTitle(s.optString("name", "") + " · 每次拉几篇")
                .setSingleChoiceItems(labels, idx, (d, which) -> {
                    putSource(s, "limit", opts[which]);
                    d.dismiss();
                })
                .setNegativeButton(R.string.add_cancel, null)
                .show();
    }

    /**
     * 只提交要改的那个字段。
     * 服务端对缺省字段保持原值，所以改开关不会顺手把 Cookie / 自动拉取间隔清掉。
     */
    private void putSource(final JSONObject s, String key, Object value) {
        final String id = s.optString("id");
        final String name = s.optString("name", "");
        String payload;
        try {
            payload = new JSONObject().put(key, value).toString();
        } catch (Exception e) {
            return;
        }
        Api.async("PUT", "/api/sources/" + id, payload, r -> {
            if (!r.ok()) {
                String why = r.error != null ? r.error : ("HTTP " + r.code);
                Toast.makeText(this, getString(R.string.save_fail, why), Toast.LENGTH_LONG).show();
                return;
            }
            String okText;
            if ("enabled".equals(key)) okText = name + (Boolean.TRUE.equals(value) ? "：已启用" : "：已停用");
            else okText = getString(R.string.saved_ok);
            Toast.makeText(this, okText, Toast.LENGTH_SHORT).show();
            load(true);
        });
    }

    private void load(boolean keepStatus) {
        // keepStatus：拉取完要保留「存入 3 篇 · 跳过 2 篇」那行结果，
        // 以前这里无条件先写「正在读取来源…」，结果瞬间被冲掉，用户只看到一句无意义的话
        if (!keepStatus) status.setText(R.string.loading);
        Api.async("GET", "/api/sources", null, r -> {
            if (!r.ok()) {
                status.setText(getString(R.string.load_fail, r.error != null ? r.error : ("HTTP " + r.code)));
                return;
            }
            try {
                JSONArray arr = new JSONArray(r.body);
                sources.clear();
                for (int i = 0; i < arr.length(); i++) sources.add(arr.getJSONObject(i));
                list.invalidateViews();
                if (!keepStatus) status.setText(getString(R.string.hot_tip));
            } catch (Exception e) {
                status.setText(e.getMessage() == null ? "" : e.getMessage());
            }
        });
    }

    private void pull(final JSONObject s) {
        String id = s.optString("id");
        int limit = s.optInt("limit", 5);
        status.setText(getString(R.string.hot_pulling, s.optString("name", "")));
        String payload;
        try {
            payload = new JSONObject().put("limit", limit).toString();
        } catch (Exception e) {
            status.setText(String.valueOf(e.getMessage()));
            return;
        }
        Api.async("POST", "/api/sources/" + id + "/pull", payload, PULL_TIMEOUT_MS,
                r -> {
                    if (!r.ok()) {
                        String why = r.error != null ? r.error : ("HTTP " + r.code);
                        status.setText(getString(R.string.load_fail, why));
                        Toast.makeText(this, getString(R.string.load_fail, why), Toast.LENGTH_LONG).show();
                        return;
                    }
                    try {
                        JSONObject d = new JSONObject(r.body);
                        int saved = d.optJSONArray("saved") == null ? 0 : d.getJSONArray("saved").length();
                        JSONArray skippedArr = d.optJSONArray("skipped");
                        JSONArray errs = d.optJSONArray("errors");
                        int skipped = skippedArr == null ? 0 : skippedArr.length();
                        int errCount = errs == null ? 0 : errs.length();
                        StringBuilder sb = new StringBuilder("存入 " + saved + " 篇");
                        if (skipped > 0) sb.append("，跳过 ").append(skipped).append(" 篇（多半已经收藏过）");
                        if (errCount > 0) {
                            sb.append("，失败 ").append(errCount).append(" 篇");
                            String em = errs.getJSONObject(0).optString("error", "");
                            if (em.length() > 0) sb.append("\n").append(em);
                        }
                        sb.append("\n用时 ").append(d.optInt("durationMs", 0) / 1000).append(" 秒");
                        status.setText(sb.toString());
                        Toast.makeText(this, sb.toString(), Toast.LENGTH_LONG).show();
                    } catch (Exception e) {
                        status.setText(e.getMessage() == null ? "" : e.getMessage());
                    }
                    load(true);
                });
    }

    private void pullAll() {
        status.setText(R.string.hot_pulling_all);
        Api.async("POST", "/api/sources/pull-all", "{}", PULL_ALL_TIMEOUT_MS, r -> {
            if (!r.ok()) {
                String why = r.error != null ? r.error : ("HTTP " + r.code);
                status.setText(getString(R.string.load_fail, why));
                Toast.makeText(this, getString(R.string.load_fail, why), Toast.LENGTH_LONG).show();
                return;
            }
            try {
                JSONObject d = new JSONObject(r.body);
                JSONArray results = d.optJSONArray("results");
                int saved = 0;
                int errs = 0;
                for (int i = 0; results != null && i < results.length(); i++) {
                    JSONObject one = results.getJSONObject(i);
                    JSONArray a = one.optJSONArray("saved");
                    JSONArray b = one.optJSONArray("errors");
                    if (a != null) saved += a.length();
                    if (b != null) errs += b.length();
                }
                String msg = "全部拉取完成：存入 " + saved + " 篇" + (errs > 0 ? "，失败 " + errs + " 篇" : "");
                status.setText(msg);
                Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
            } catch (Exception e) {
                status.setText(e.getMessage() == null ? "" : e.getMessage());
            }
            load(true);
        });
    }

    /** 填/改/清 Cookie。留空保存 = 清除。 */
    private void showCookieDialog(final JSONObject s) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        input.setHint("z_c0=…");
        input.setText(cookieDraft);
        input.setMinLines(3);
        input.setSingleLine(false);

        String hint = s.optString("cookieHint", "");
        if (s.optBoolean("hasCookie", false)) {
            hint = "已配置 Cookie（留空保存 = 清除，换新的就整行重贴）。\n" + hint;
        }
        new AlertDialog.Builder(this)
                .setTitle(s.optString("name", "") + " · Cookie")
                .setMessage(hint)
                .setView(input)
                .setNegativeButton(R.string.add_cancel, null)
                .setPositiveButton(R.string.cookie_save, (d, w) -> saveCookie(s, input.getText().toString().trim()))
                .show();
    }

    private void saveCookie(final JSONObject s, final String cookie) {
        String id = s.optString("id");
        cookieDraft = cookie;
        String payload;
        try {
            payload = new JSONObject().put("cookie", cookie).toString();
        } catch (Exception e) {
            status.setText(String.valueOf(e.getMessage()));
            return;
        }
        Api.async("PUT", "/api/sources/" + id, payload, r -> {
            if (!r.ok()) {
                String why = r.error != null ? r.error : ("HTTP " + r.code);
                status.setText(getString(R.string.cookie_fail, why));
                Toast.makeText(this, getString(R.string.cookie_fail, why), Toast.LENGTH_LONG).show();
                return;
            }
            String msg = cookie.isEmpty()
                    ? getString(R.string.cookie_cleared)
                    : getString(R.string.cookie_saved, s.optString("name", ""));
            status.setText(msg);
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
            load(true);
        });
    }
}
