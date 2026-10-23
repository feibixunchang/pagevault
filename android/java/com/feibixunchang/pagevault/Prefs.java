package com.feibixunchang.pagevault;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;

/** 各种偏好：服务端地址、外观、字号、字体、阅读模式。 */
public final class Prefs {

    public static final String THEME_AUTO = "auto";
    public static final String THEME_LIGHT = "light";
    public static final String THEME_DARK = "dark";

    public static final String FONT_SYSTEM = "system";
    public static final String FONT_SONGTI = "songti";
    public static final String FONT_HEITI = "heiti";
    public static final String FONT_KAITI = "kaiti";

    private static SharedPreferences sp;

    private static void ensure(Context c) {
        if (sp == null) {
            sp = c.getApplicationContext().getSharedPreferences("pv", Context.MODE_PRIVATE);
        }
    }

    public static SharedPreferences sp(Context c) {
        ensure(c);
        return sp;
    }

    public static String serverUrl() {
        if (sp == null) return Api.DEFAULT_SERVER;
        return serverUrl(sp);
    }

    public static String serverUrl(Context c) {
        ensure(c);
        return serverUrl(sp);
    }

    private static String serverUrl(SharedPreferences prefs) {
        String v = prefs.getString("serverUrl", "");
        if (v == null || v.trim().length() == 0) return Api.DEFAULT_SERVER;
        v = v.trim();
        if (!v.startsWith("http://") && !v.startsWith("https://")) v = "http://" + v;
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }

    public static void setServerUrl(Context c, String v) {
        ensure(c);
        sp.edit().putString("serverUrl", v == null ? "" : v.trim()).apply();
    }

    public static String theme(Context c) {
        ensure(c);
        return sp.getString("theme", THEME_AUTO);
    }

    public static void setTheme(Context c, String v) {
        ensure(c);
        sp.edit().putString("theme", v).apply();
    }

    /** true 表示界面按深色渲染。 */
    public static boolean isDark(Context c) {
        String t = theme(c);
        if (THEME_LIGHT.equals(t)) return false;
        if (THEME_DARK.equals(t)) return true;
        int mode = c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    public static void applyTheme(android.app.Activity a) {
        a.setTheme(isDark(a) ? R.style.Theme_PageVault_Dark : R.style.Theme_PageVault_Light);
    }

    // 字号档位：s / m / l / xl / xxl，对应正文 15 / 17 / 19.5 / 22 / 24 px
    public static String fontSize(Context c) {
        ensure(c);
        return sp.getString("fontSize", "m");
    }

    public static void setFontSize(Context c, String v) {
        ensure(c);
        sp.edit().putString("fontSize", v).apply();
    }

    public static float fontSizePx(Context c) {
        String s = fontSize(c);
        if ("s".equals(s)) return 15f;
        if ("l".equals(s)) return 19.5f;
        if ("xl".equals(s)) return 22f;
        if ("xxl".equals(s)) return 24f;
        return 17f;
    }

    public static boolean bold(Context c) {
        ensure(c);
        return sp.getBoolean("bold", false);
    }

    public static void setBold(Context c, boolean v) {
        ensure(c);
        sp.edit().putBoolean("bold", v).apply();
    }

    public static boolean readerMode(Context c) {
        ensure(c);
        return sp.getBoolean("readerMode", true);
    }

    public static void setReaderMode(Context c, boolean v) {
        ensure(c);
        sp.edit().putBoolean("readerMode", v).apply();
    }

    public static String font(Context c) {
        ensure(c);
        return sp.getString("font", FONT_SYSTEM);
    }

    public static void setFont(Context c, String v) {
        ensure(c);
        sp.edit().putString("font", v).apply();
    }
}
