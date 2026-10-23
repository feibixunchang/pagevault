package com.feibixunchang.pagevault;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 正文字体。
 *
 * 安卓系统自带 Noto Sans CJK（黑体感）和 Noto Serif CJK（宋体感），
 * 但没有楷体，所以楷体要自己下载。跟 iOS 端用同一批开源字体：
 * 思源宋体 / 思源黑体 / 霞鹜文楷（都是 OFL 协议，可自由分发）。
 *
 * 下载下来的字体存到 App 私有目录，再用 @font-face 以 file:// 引用给 WebView。
 */
public final class Fonts {

    public static class Spec {
        public final String id;
        public final String title;
        public final String subtitle;
        public final String familyName;
        public final String fileName;
        public final double sizeMB;
        public final String[] urls;

        Spec(String id, String title, String subtitle, String familyName, String fileName,
             double sizeMB, String[] urls) {
            this.id = id;
            this.title = title;
            this.subtitle = subtitle;
            this.familyName = familyName;
            this.fileName = fileName;
            this.sizeMB = sizeMB;
            this.urls = urls;
        }
    }

    public static final Spec[] SPECS = {
        new Spec("songti", "宋体", "思源宋体", "Noto Serif SC", "NotoSerifSC-Regular.otf", 11.1,
                mirrors("googlefonts/noto-cjk/main/Serif/SubsetOTF/SC/NotoSerifSC-Regular.otf")),
        new Spec("heiti", "黑体", "思源黑体", "Noto Sans SC", "NotoSansSC-Regular.otf", 7.9,
                mirrors("googlefonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf")),
        new Spec("kaiti", "楷体", "霞鹜文楷", "LXGW WenKai Lite", "LXGWWenKaiLite-Regular.ttf", 13.3,
                mirrors("lxgw/LxgwWenKai-Lite/main/fonts/TTF/LXGWWenKaiLite-Regular.ttf"))
    };

    /** 同一个文件的多个下载渠道，前一个不通就试下一个（顺序是实测出来的）。 */
    private static String[] mirrors(String ghPath) {
        return new String[]{
                "https://ghfast.top/https://raw.githubusercontent.com/" + ghPath,
                "https://ghproxy.net/https://raw.githubusercontent.com/" + ghPath,
                "https://gh-proxy.com/https://raw.githubusercontent.com/" + ghPath,
                "https://cdn.jsdelivr.net/gh/" + ghPath,
                "https://fastly.jsdelivr.net/gh/" + ghPath
        };
    }

    public static Spec spec(String id) {
        for (Spec s : SPECS) if (s.id.equals(id)) return s;
        return null;
    }

    public static File fontDir(Context c) {
        File d = new File(c.getFilesDir(), "fonts");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    public static File fontFile(Context c, Spec s) {
        return new File(fontDir(c), s.fileName);
    }

    public static boolean installed(Context c, String id) {
        Spec s = spec(id);
        if (s == null) return false;
        File f = fontFile(c, s);
        return f.exists() && f.length() > 100 * 1024;
    }

    public static String installedIds(Context c) {
        StringBuilder sb = new StringBuilder();
        for (Spec s : SPECS) {
            if (installed(c, s.id)) {
                if (sb.length() > 0) sb.append(",");
                sb.append(s.id);
            }
        }
        return sb.toString();
    }

    /** 下载字体；成功返回文件，失败抛异常（错误信息里带最后一个渠道的原因）。 */
    public static File download(Context c, Spec s) throws Exception {
        File tmp = new File(fontDir(c), s.fileName + ".part");
        Exception last = null;
        for (String u : s.urls) {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(u).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(180000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "PageVault-Android");
                int code = conn.getResponseCode();
                if (code != 200) {
                    last = new Exception("HTTP " + code);
                    continue;
                }
                InputStream in = conn.getInputStream();
                FileOutputStream out = new FileOutputStream(tmp);
                byte[] buf = new byte[65536];
                int n;
                long total = 0;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    total += n;
                }
                in.close();
                out.close();
                if (total < 100 * 1024) {
                    last = new Exception("文件不完整");
                    continue;
                }
                File target = fontFile(c, s);
                if (target.exists()) target.delete();
                if (!tmp.renameTo(target)) {
                    last = new Exception("无法保存到 " + target.getAbsolutePath());
                    continue;
                }
                return target;
            } catch (Exception e) {
                last = e;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        if (tmp.exists()) tmp.delete();
        throw last == null ? new Exception("所有下载渠道都连不上") : last;
    }

    /**
     * 给 WebView 用的 CSS：@font-face + 字体族。
     * 字体没下载时退回系统自带（黑体/宋体 Android 都有，楷体退回衬线）。
     */
    public static String readerFontCss(Context c) {
        String id = Prefs.font(c);
        Spec s = spec(id);
        String fallback = "sans-serif";
        if (s != null && installed(c, id)) {
            File f = fontFile(c, s);
            String url = "file://" + f.getAbsolutePath();
            return "@font-face{font-family:'PVFont';src:url('" + url + "');font-weight:normal;font-style:normal;}\n"
                    + "body,.rv-body{font-family:'PVFont'," + fallback + " !important;}";
        }
        if ("songti".equals(id)) fallback = "serif";
        else if ("kaiti".equals(id)) fallback = "serif";
        else if ("heiti".equals(id)) fallback = "sans-serif";
        return "body,.rv-body{font-family:" + fallback + " !important;}";
    }
}
