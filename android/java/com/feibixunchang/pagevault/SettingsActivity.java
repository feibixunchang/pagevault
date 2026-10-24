package com.feibixunchang.pagevault;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.CheckBox;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/** 设置：服务端地址、外观、字号、粗体、只读正文、正文字体（可下载）。 */
public class SettingsActivity extends Activity {

    private EditText serverInput;
    private RadioGroup themeGroup;
    private RadioGroup sizeGroup;
    private CheckBox boldBox;
    private CheckBox readerBox;
    private TextView fontState, versionLine;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Prefs.applyTheme(this);
        super.onCreate(savedInstanceState);
        // 别指望 MainActivity 一定先跑过：进程被杀后系统恢复、或从「分享」直接进来时，
        // 这里要是没有 Api.init，请求会退回到写死的默认服务器地址，存的库不是用户配的那台。
        Api.init(this);
        setContentView(R.layout.activity_settings);

        serverInput = findViewById(R.id.serverInput);
        themeGroup = findViewById(R.id.themeGroup);
        sizeGroup = findViewById(R.id.sizeGroup);
        boldBox = findViewById(R.id.boldBox);
        readerBox = findViewById(R.id.readerBox);
        fontState = findViewById(R.id.fontState);
        versionLine = findViewById(R.id.versionLine);

        findViewById(R.id.btnBack).setOnClickListener(v -> finish());
        versionLine.setText(getString(R.string.settings_version) + " v" + BuildConfig.VERSION);

        serverInput.setText(Prefs.serverUrl(this));
        findViewById(R.id.btnTest).setOnClickListener(v -> testConnection());
        // 地址填错了（比如指向一台已经关机的电脑）时，一键回到默认的 NAS
        findViewById(R.id.btnResetServer).setOnClickListener(v -> {
            serverInput.setText(Api.DEFAULT_SERVER);
            Prefs.setServerUrl(this, Api.DEFAULT_SERVER);
            Toast.makeText(this, R.string.add_saved, Toast.LENGTH_SHORT).show();
        });
        findViewById(R.id.btnSaveServer).setOnClickListener(v -> {
            Prefs.setServerUrl(this, serverInput.getText().toString());
            Toast.makeText(this, R.string.add_saved, Toast.LENGTH_SHORT).show();
        });

        themeGroup.check(radioId(Prefs.theme(this)));
        themeGroup.setOnCheckedChangeListener((g, id) -> {
            Prefs.setTheme(this, themeOf(id));
            recreate();
        });

        sizeGroup.check(sizeRadioId(Prefs.fontSize(this)));
        sizeGroup.setOnCheckedChangeListener((g, id) -> Prefs.setFontSize(this, sizeOf(id)));

        boldBox.setChecked(Prefs.bold(this));
        boldBox.setOnCheckedChangeListener((b, on) -> Prefs.setBold(this, on));

        readerBox.setChecked(Prefs.readerMode(this));
        readerBox.setOnCheckedChangeListener((b, on) -> Prefs.setReaderMode(this, on));

        findViewById(R.id.btnFont).setOnClickListener(v -> pickFont());
        updateFontState();
    }

    private void updateFontState() {
        String id = Prefs.font(this);
        String name;
        if (Prefs.FONT_SYSTEM.equals(id)) {
            name = getString(R.string.settings_font_system);
        } else {
            Fonts.Spec s = Fonts.spec(id);
            name = s == null ? id : (s.title + " · " + s.subtitle);
        }
        boolean installed = Fonts.installed(this, id);
        fontState.setText(name + " · " + getString(installed ? R.string.settings_font_done : R.string.settings_font_need));
    }

    private void pickFont() {
        final String[] ids = {Prefs.FONT_SYSTEM, Prefs.FONT_SONGTI, Prefs.FONT_HEITI, Prefs.FONT_KAITI};
        String[] names = new String[ids.length];
        for (int i = 0; i < ids.length; i++) {
            if (Prefs.FONT_SYSTEM.equals(ids[i])) {
                names[i] = getString(R.string.settings_font_system) + "（" + getString(R.string.settings_font_heiti) + "）";
            } else {
                Fonts.Spec s = Fonts.spec(ids[i]);
                names[i] = s.title + " · " + s.subtitle + "（" + String.format(java.util.Locale.getDefault(), "%.1f MB", s.sizeMB) + "）";
            }
        }
        int cur = 0;
        for (int i = 0; i < ids.length; i++) if (ids[i].equals(Prefs.font(this))) cur = i;
        new AlertDialog.Builder(this)
                .setTitle(R.string.settings_font)
                .setSingleChoiceItems(names, cur, (d, which) -> {
                    d.dismiss();
                    final String pick = ids[which];
                    Prefs.setFont(this, pick);
                    updateFontState();
                    if (Prefs.FONT_SYSTEM.equals(pick)) return;
                    if (Fonts.installed(this, pick)) return;
                    // 需要下载
                    final Fonts.Spec s = Fonts.spec(pick);
                    new AlertDialog.Builder(this)
                            .setMessage(s.title + " · " + s.subtitle + "\n" + String.format(java.util.Locale.getDefault(), "%.1f MB", s.sizeMB))
                            .setNegativeButton(R.string.add_cancel, null)
                            .setPositiveButton(R.string.settings_font_download, (d2, w2) -> downloadFont(s))
                            .show();
                })
                .setNegativeButton(R.string.add_cancel, null)
                .show();
    }

    private void downloadFont(final Fonts.Spec s) {
        final TextView tip = findViewById(R.id.fontTip);
        tip.setVisibility(View.VISIBLE);
        tip.setText(getString(R.string.settings_font_downloading));
        new Thread(() -> {
            String err = null;
            try {
                Fonts.download(SettingsActivity.this, s);
            } catch (Exception e) {
                err = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            }
            final String e2 = err;
            runOnUiThread(() -> {
                tip.setVisibility(View.GONE);
                if (e2 == null) {
                    Toast.makeText(this, R.string.settings_font_done, Toast.LENGTH_SHORT).show();
                    updateFontState();
                } else {
                    Toast.makeText(this, getString(R.string.settings_font_fail, e2), Toast.LENGTH_LONG).show();
                }
            });
        }).start();
    }

    private void testConnection() {
        final String url = serverInput.getText().toString().trim();
        Prefs.setServerUrl(this, url);
        Toast.makeText(this, R.string.loading, Toast.LENGTH_SHORT).show();
        Api.async("GET", "/api/status", null, r -> {
            if (!r.ok()) {
                Toast.makeText(this, getString(R.string.settings_test_fail,
                        r.error != null ? r.error : ("HTTP " + r.code)), Toast.LENGTH_LONG).show();
                return;
            }
            try {
                JSONObject o = new JSONObject(r.body);
                String ver = o.optString("version", "?");
                String plat = o.optString("platform", "?");
                Toast.makeText(this, getString(R.string.settings_test_ok, plat + " v" + ver), Toast.LENGTH_LONG).show();
            } catch (Exception e) {
                Toast.makeText(this, getString(R.string.settings_test_ok, "?"), Toast.LENGTH_LONG).show();
            }
        });
    }

    private int radioId(String theme) {
        if (Prefs.THEME_LIGHT.equals(theme)) return R.id.themeLight;
        if (Prefs.THEME_DARK.equals(theme)) return R.id.themeDark;
        return R.id.themeAuto;
    }

    private String themeOf(int id) {
        if (id == R.id.themeLight) return Prefs.THEME_LIGHT;
        if (id == R.id.themeDark) return Prefs.THEME_DARK;
        return Prefs.THEME_AUTO;
    }

    private int sizeRadioId(String size) {
        if ("s".equals(size)) return R.id.sizeS;
        if ("l".equals(size)) return R.id.sizeL;
        if ("xl".equals(size)) return R.id.sizeXL;
        if ("xxl".equals(size)) return R.id.sizeXXL;
        return R.id.sizeM;
    }

    private String sizeOf(int id) {
        if (id == R.id.sizeS) return "s";
        if (id == R.id.sizeL) return "l";
        if (id == R.id.sizeXL) return "xl";
        if (id == R.id.sizeXXL) return "xxl";
        return "m";
    }
}
