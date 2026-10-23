package com.feibixunchang.pagevault;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 与「网页收藏」服务端的通信层。
 *
 * 只用系统自带的 HttpURLConnection + org.json，不引任何第三方库：
 * 这样安卓端不需要 Gradle/Maven 就能直接构建出 APK，也方便用户自己维护。
 */
public final class Api {

    public static final String DEFAULT_SERVER = "http://192.168.1.2:8731";

    private static final ExecutorService POOL = Executors.newFixedThreadPool(4);
    private static Context appContext;

    /** 记住 Application Context，后台线程也能读到偏好。 */
    public static void init(Context c) {
        appContext = c.getApplicationContext();
        Prefs.sp(appContext);
    }

    public static class Result {
        public final int code;
        public final String body;
        public final String error;

        Result(int code, String body, String error) {
            this.code = code;
            this.body = body;
            this.error = error;
        }

        public boolean ok() {
            return error == null && code >= 200 && code < 300;
        }
    }

    public interface Callback {
        void done(Result r);
    }

    /** 后台线程里跑请求，回调切回主线程。 */
    public static void async(final String method, final String path, final String body,
                             final Callback cb) {
        POOL.execute(new Runnable() {
            @Override
            public void run() {
                final Result r = request(method, path, body);
                new android.os.Handler(android.os.Looper.getMainLooper()).post(new Runnable() {
                    @Override
                    public void run() {
                        cb.done(r);
                    }
                });
            }
        });
    }

    public static Result request(String method, String path, String body) {
        HttpURLConnection conn = null;
        try {
            String base = appContext != null ? Prefs.serverUrl(appContext) : Api.DEFAULT_SERVER;
            if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
            URL u = new URL(base + path);
            conn = (HttpURLConnection) u.openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(90000);
            conn.setRequestProperty("Accept", "application/json");
            if (body != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] b = body.getBytes("UTF-8");
                conn.setFixedLengthStreamingMode(b.length);
                OutputStream os = conn.getOutputStream();
                os.write(b);
                os.close();
            }
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = in == null ? "" : readAll(in);
            return new Result(code, text, null);
        } catch (Exception e) {
            String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            return new Result(0, "", msg);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), "UTF-8");
    }

    // ---------- 业务接口 ----------

    public static JSONArray pages() throws Exception {
        Result r = request("GET", "/api/pages", null);
        if (!r.ok()) throw new Exception("HTTP " + r.code);
        return new JSONArray(r.body);
    }

    public static String html(String id) throws Exception {
        Result r = request("GET", "/p/" + id, null);
        if (!r.ok()) throw new Exception("HTTP " + r.code);
        return r.body;
    }

    public static boolean toggleStar(String id) throws Exception {
        Result r = request("PATCH", "/api/pages/" + id + "/star", null);
        if (!r.ok()) throw new Exception("HTTP " + r.code);
        return new JSONObject(r.body).optBoolean("starred", false);
    }

    public static void delete(String id) throws Exception {
        Result r = request("DELETE", "/api/pages/" + id, null);
        if (!r.ok()) throw new Exception("HTTP " + r.code);
    }

    /** 手机上按链接保存：服务端去抓页面并存库。 */
    public static JSONObject saveFromURL(String url, String title) throws Exception {
        JSONObject o = new JSONObject();
        o.put("url", url);
        o.put("platform", "android");
        if (title != null && title.trim().length() > 0) o.put("title", title.trim());
        Result r = request("POST", "/api/pages/from-url", o.toString());
        if (!r.ok()) {
            String msg = r.body;
            try {
                msg = new JSONObject(r.body).optString("error", msg);
            } catch (Exception ignored) { }
            throw new Exception(msg.isEmpty() ? ("HTTP " + r.code) : msg);
        }
        return new JSONObject(r.body);
    }

    public static JSONObject status() throws Exception {
        Result r = request("GET", "/api/status", null);
        if (!r.ok()) throw new Exception("HTTP " + r.code);
        return new JSONObject(r.body);
    }

    /** 服务端上带的 readability.js，用于「只显示正文」。 */
    public static String readabilityScript() throws Exception {
        Result r = request("GET", "/readability.js", null);
        if (!r.ok()) throw new Exception("HTTP " + r.code);
        return r.body;
    }

    public static String cacheDir(Context c) {
        return c.getFilesDir().getAbsolutePath();
    }
}
