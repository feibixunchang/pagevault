'use strict';

// 同步引擎：把本地收藏库与「一个或多个同步目标」互相同步。
//
// 目标类型见 providers.js：
//   - webdav : 用户自己的网盘（同一账号 = 多端同步，数据只在自己网盘）
//   - peer   : 另一台跑着本程序的机器（家里 NAS 当同步中枢 / 备份源）
//
// 多目标的意义（也是用户提的实际需求）：
//   桌面端可以同时挂「坚果云 WebDAV」+「家里 NAS」，任何一边写入都会经本地库
//   顺序同步到另一边；NAS 自己也可以挂 WebDAV 做异地备份。所有目标彼此独立，
//   一个连不上不影响另一个。
//
// 合并规则（与单目标时代一致）：
//   - 按页面 id 去重：本地没有的下载，远端没有的上传
//   - 收藏（starred）冲突：starredAt 时间戳新的赢
//   - 删除：本地删除 -> 删远端文件 + 记 tombstone；tombstone 取并集后应用
//   - 索引每次合并后全量覆盖（自愈：漏条目可由 pages/ 目录+文件头注释重建）

const { createProvider } = require('./providers');

const ONLINE_WINDOW_MS = 120000; // 扩展"已连接"判定窗口（与心跳周期匹配）
const TICK_MS = 5000;            // 调度器检查间隔
// 页面 id 必须是安全字符（uuid 都是 [\w-]）：远端索引/文件列表里的 id 不可信，
// 带 ../ 的 id 会穿过 pages/ 目录写到机器上任何位置（writePage 拿它拼路径）。
const SAFE_PAGE_ID = /^[\w-]{1,80}$/;
function badPageId(id) { return !SAFE_PAGE_ID.test(String(id || '')); }

function extractMeta(html) {
  const m = /<!--\s*pv-meta:([\s\S]*?)-->/i.exec(html || '');
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

class SyncEngine {
  // hooks: { loadIndex, saveIndex, loadDeletions, saveDeletions, writePage(id, html),
  //          readPage(id), deletePageFile(id), log(), onSynced(stats, target) }
  constructor(hooks) {
    this.hooks = hooks;
    this.targets = new Map();  // id -> { meta, state }
    this.timer = null;
    this._deb = null;
    this._cfg = null;
  }

  _entry(t) {
    let e = this.targets.get(t.id);
    if (!e) {
      e = {
        meta: { name: t.name || t.type, type: t.type, enabled: t.enabled !== false },
        state: { status: 'idle', lastSyncAt: 0, lastError: '', lastStats: null, running: false, nextDue: 0 }
      };
      this.targets.set(t.id, e);
    } else {
      e.meta.name = t.name || t.type;
      e.meta.type = t.type;
      e.meta.enabled = t.enabled !== false;
    }
    return e;
  }

  getStatus() {
    const list = [...this.targets.entries()].map(([id, e]) => ({
      id,
      name: e.meta.name,
      type: e.meta.type,
      enabled: e.meta.enabled,
      status: e.state.status,
      lastSyncAt: e.state.lastSyncAt,
      lastError: e.state.lastError,
      lastStats: e.state.lastStats
    }));
    const on = list.filter(t => t.enabled);
    const syncing = on.find(t => t.status === 'syncing');
    const failed = on.find(t => t.status === 'error');
    const done = on.filter(t => t.lastSyncAt).sort((a, b) => b.lastSyncAt - a.lastSyncAt)[0];

    // 聚合统计：状态栏只显示一行，给用户看总量更有意义
    const total = { pulled: 0, pushed: 0, deleted: 0, errors: [] };
    for (const t of on) {
      const s = t.lastStats;
      if (!s) continue;
      total.pulled += s.pulled || 0;
      total.pushed += s.pushed || 0;
      total.deleted += s.deleted || 0;
    }

    let status = 'idle';
    if (!on.length) status = 'disabled';
    else if (syncing) status = 'syncing';
    else if (failed) status = 'error';
    else if (done) status = 'ok';

    return {
      status,
      configured: on.length > 0,
      lastSyncAt: done ? done.lastSyncAt : 0,
      lastError: failed ? (failed.name + '：' + failed.lastError) : '',
      lastStats: total,
      targets: list
    };
  }

  // 完整一轮：对每个启用的目标 pull -> merge -> push。串行执行，
  // 这样后一个目标能立刻拿到前一个目标拉下来的数据（WebDAV 与 NAS 互为镜像）。
  async runAll(cfg) {
    const on = (cfg && cfg.targets || []).filter(t => t.enabled !== false);
    const out = [];
    for (const t of on) out.push(await this.runOne(t, cfg));
    return out;
  }

  async runOne(target, cfg) {
    const e = this._entry(target);
    const st = e.state;
    if (st.running) return st.lastStats || { pulled: 0, pushed: 0, deleted: 0, errors: ['上一次同步还没结束'] };
    st.running = true;
    st.status = 'syncing';

    const errors = [];
    const stats = { pulled: 0, pushed: 0, deleted: 0, errors };

    try {
      const prov = createProvider(target);
      await prov.ensure();

      // ---------- pull ----------
      const remoteIndex = await prov.getIndex();
      const remoteMap = new Map(remoteIndex.filter(m => m && m.id).map(m => [m.id, m]));
      const remoteIds = await prov.listIds();
      const remoteDeletions = await prov.getDeletions();

      let localIndex = this.hooks.loadIndex();
      const localMap = new Map(localIndex.map(m => [m.id, m]));

      // 先把删除记录（tombstone）合成一张表：pull 阶段就要跳过已删的 id，
      // 否则"在 A 删掉、B 还没同步"的页面会被拉回来再删一次（白下载 + 日志噪音）。
      const localDeletions = this.hooks.loadDeletions();
      const delMap = new Map();
      for (const d of localDeletions.concat(remoteDeletions)) {
        if (d && d.id) delMap.set(d.id, String(d.deletedAt || ''));
      }

      for (const rm of remoteIndex) {
        if (!rm || !rm.id) continue;
        if (badPageId(rm.id)) { errors.push('远端页面 id 非法，跳过：' + rm.id); continue; }
        if (delMap.has(rm.id)) continue;
        if (localMap.has(rm.id)) {
          // 星标冲突：starredAt 新的赢
          const lm = localMap.get(rm.id);
          if (!!rm.starred !== !!lm.starred && String(rm.starredAt || '') > String(lm.starredAt || '')) {
            lm.starred = rm.starred;
            lm.starredAt = rm.starredAt;
          }
          continue;
        }
        const html = await prov.getPage(rm.id);
        if (html == null) { errors.push('远端页面下载失败：' + rm.id); continue; }
        this.hooks.writePage(rm.id, html);
        const nm = this.hooks.normalizeMeta(rm, html);
        localIndex.push(nm);
        localMap.set(rm.id, nm);
        stats.pulled++;
      }

      // 孤儿文件自愈：远端有页面文件、索引里没有 -> 读文件头 pv-meta 恢复
      for (const id of remoteIds) {
        if (badPageId(id)) continue;
        if (delMap.has(id) || localMap.has(id) || remoteMap.has(id)) continue;
        const html = await prov.getPage(id);
        if (html == null) continue;
        const meta = extractMeta(html);
        if (!meta || !meta.id) continue;
        this.hooks.writePage(id, html);
        const nm = this.hooks.normalizeMeta(meta, html);
        localIndex.push(nm);
        localMap.set(id, nm);
        stats.pulled++;
      }

      // ---------- 应用删除记录（tombstone 并集）----------
      for (const [id] of delMap) {
        if (localMap.has(id)) {
          this.hooks.deletePageFile(id);
          localIndex = localIndex.filter(m => m.id !== id);
          localMap.delete(id);
          stats.deleted++;
        }
      }
      const delList = [...delMap].map(([id, deletedAt]) => ({ id, deletedAt }));
      this.hooks.saveDeletions(delList);

      // ---------- push ----------
      for (const meta of localIndex) {
        const remoteMeta = remoteMap.get(meta.id);
        if (remoteMeta || remoteIds.has(meta.id)) {
          // 已存在：只在本地星标更新时单独推一次元数据（WebDAV 由 index.json 覆盖完成）
          if (remoteMeta && !!meta.starred !== !!remoteMeta.starred
              && String(meta.starredAt || '') > String(remoteMeta.starredAt || '')) {
            try { await prov.putMeta(meta); stats.pushed++; } catch (e) { errors.push('同步星标失败：' + e.message); }
          }
          continue;
        }
        const html = this.hooks.readPage(meta.id);
        if (html == null) { errors.push('本地页面文件缺失，跳过上传：' + meta.id); continue; }
        try {
          await prov.putPage(meta.id, html, meta);
          remoteIds.add(meta.id);
          stats.pushed++;
        } catch (e) {
          errors.push('上传失败（' + meta.id + '）：' + e.message);
        }
      }

      // 清理远端残留（本地删过但远端还在）
      for (const id of remoteIds) {
        if (delMap.has(id) && !localMap.has(id)) {
          try { await prov.delPage(id); } catch { /* 远端已没有就算了 */ }
        }
      }

      // 合并写回索引：localIndex 是本轮开始时的快照，而同步过程中（多个 await 网络）
      // 扩展保存 / 对端推送 / 收藏 都会改磁盘上的 index.json。直接 saveIndex(localIndex)
      // 会把"同步期间新增的页面"整体抹掉（文件还在盘上、条目却从索引消失）。
      // 正确做法：以磁盘最新索引为基底，叠加本轮 pull/normalize/star 的结果，
      // 再按墓碑过滤，最后写回。星标冲突按 starredAt 新的赢。
      const diskNow = this.hooks.loadIndex().filter(m => m && m.id && !delMap.has(m.id));
      const byId = new Map(diskNow.map(m => [m.id, m]));
      for (const m of localIndex) {
        if (!m || !m.id || delMap.has(m.id)) continue;
        const cur = byId.get(m.id);
        if (!cur) { byId.set(m.id, m); continue; }
        // 同 id：本轮已 pull/normalize 过（含远端更新），若磁盘版本星标更新则保留星标字段
        if (!!cur.starred !== !!m.starred && String(cur.starredAt || '') > String(m.starredAt || '')) {
          m.starred = cur.starred; m.starredAt = cur.starredAt;
        }
        byId.set(m.id, m);
      }
      const finalIndex = [...byId.values()];

      this.hooks.saveIndex(finalIndex);
      await prov.putIndex(finalIndex);
      await prov.putDeletions(delList);

      st.status = errors.length && !stats.pulled && !stats.pushed ? 'error' : 'ok';
      st.lastSyncAt = Date.now();
      st.lastError = errors.length ? errors[0] : '';
      st.lastStats = stats;
      if (this.hooks.onSynced) this.hooks.onSynced(stats, target);
      const tag = (target.name || target.type) + '@' + (target.url || '');
      this.hooks.log('sync[' + tag + '] ok: pulled=' + stats.pulled + ' pushed=' + stats.pushed
        + ' deleted=' + stats.deleted + (errors.length ? ' errors=' + errors.length + ' (' + errors[0] + ')' : ''));
      return stats;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      errors.push(msg);
      st.status = 'error';
      st.lastError = msg;
      st.lastStats = stats;
      this.hooks.log('sync[' + (target.name || target.type) + '] failed: ' + msg);
      return stats;
    } finally {
      st.running = false;
    }
  }

  // 调度器：每 5 秒看一次有没有到期该跑的目标（每个目标可有自己的间隔）
  start(cfg) {
    this.stop();
    this._cfg = cfg;
    const ids = new Set(((cfg && cfg.targets) || []).map(t => t.id));
    for (const id of [...this.targets.keys()]) if (!ids.has(id)) this.targets.delete(id);
    for (const t of (cfg && cfg.targets) || []) this._entry(t);
    const anyTimed = (cfg && cfg.targets || []).some(t => t.enabled !== false && this._intervalOf(t, cfg) > 0);
    if (!anyTimed) return;
    this.timer = setInterval(() => this._tick(), TICK_MS);
    this.hooks.log('sync scheduler started, targets=' + (cfg.targets || []).length);
  }

  _intervalOf(t, cfg) {
    const raw = (t.intervalSec === undefined || t.intervalSec === null) ? cfg.intervalSec : t.intervalSec;
    const n = Number(raw) || 0;
    return n > 0 ? Math.max(5, n) : 0;
  }

  _tick() {
    const cfg = this._cfg;
    if (!cfg) return;
    const now = Date.now();
    for (const t of cfg.targets || []) {
      if (t.enabled === false) continue;
      const iv = this._intervalOf(t, cfg);
      if (!iv) continue;
      const e = this._entry(t);
      if (e.state.running) continue;
      if (now < e.state.nextDue) continue;
      e.state.nextDue = now + iv * 1000;
      this.runOne(t, cfg);
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    clearTimeout(this._deb);
  }

  // 本地变更（保存/删除/收藏）后 debounce 触发一次，只推给"开了自动同步"的目标。
  // 必须串行（runAll）：并发跑两个目标时，各自手里的快照会互相覆盖索引，
  // 而且后一个目标拿不到前一个刚拉下来的数据 —— 与"互为镜像"的设计矛盾。
  schedule(cfg) {
    if (!cfg || !cfg.targets || !cfg.targets.length) return;
    const auto = cfg.targets.filter(t => t.enabled !== false && this._intervalOf(t, cfg) > 0);
    if (!auto.length) return;
    clearTimeout(this._deb);
    this._deb = setTimeout(() => {
      this.runAll({ ...cfg, targets: auto });
    }, 2500);
  }
}

module.exports = { SyncEngine, extractMeta, ONLINE_WINDOW_MS };
