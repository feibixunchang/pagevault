'use strict';

// 同步引擎：把本地收藏库与用户自己的 WebDAV 账号互相同步。
//
// 远端目录结构（都在同步目录 base 下）：
//   index.json       全量索引（元数据）
//   pages/<id>.html  页面文件（文件头带 pv-meta 注释，孤儿文件可自愈）
//   deletions.json   删除记录（tombstone），防止删掉的页面在别端复活
//
// 合并规则：
//   - 按页面 id 去重：本地没有的下载，远端没有的上传
//   - 收藏（starred）冲突：starredAt 时间戳新的赢
//   - 删除：本地删除 -> 删远端文件 + 记 tombstone；tombstone 取并集后应用
//   - index.json 每次合并后全量覆盖（自愈：漏条目可由 pages/ 目录+文件头注释重建）

const fs = require('fs');
const path = require('path');
const { WebDAV } = require('./webdav');

const ONLINE_WINDOW_MS = 120000; // 扩展"已连接"判定窗口（与心跳周期匹配）

function extractMeta(html) {
  const m = /<!--\s*pv-meta:([\s\S]*?)-->/i.exec(html || '');
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

class SyncEngine {
  // hooks: { loadIndex, saveIndex, loadDeletions, saveDeletions, writePage(id, html),
  //          readPage(id), deletePageFile(id), log(), onSynced(stats) }
  constructor(hooks) {
    this.hooks = hooks;
    this.state = { status: 'idle', lastSyncAt: 0, lastError: '', lastStats: null, running: false };
    this.timer = null;
    this.pending = false;
  }

  getStatus() {
    return Object.assign({}, this.state);
  }

  _dav(cfg) {
    const dav = new WebDAV(cfg.url.replace(/\/+$/, '') + '/' + String(cfg.dir || 'pagevault').replace(/^\/+|\/+$/g, ''));
    dav.auth(cfg.user, cfg.pass);
    return dav;
  }

  // 完整一轮同步：pull -> merge -> push。返回 { pulled, pushed, deleted, errors: [] }
  async run(cfg) {
    if (this.state.running) { this.pending = true; return this.state.lastStats || { pulled: 0, pushed: 0, deleted: 0, errors: [] }; }
    if (!cfg || !cfg.url || !cfg.user) {
      this.state.status = 'disabled';
      return { pulled: 0, pushed: 0, deleted: 0, errors: ['未配置 WebDAV'] };
    }
    this.state.running = true;
    this.state.status = 'syncing';
    const errors = [];
    const stats = { pulled: 0, pushed: 0, deleted: 0, errors };

    try {
      const dav = this._dav(cfg);
      await dav.ensureDir('');

      // ---------- pull ----------
      const remoteIndexRaw = await dav.get('index.json');
      let remoteIndex = [];
      try { remoteIndex = remoteIndexRaw ? JSON.parse(remoteIndexRaw.toString('utf8')) : []; } catch { errors.push('远端 index.json 解析失败，按空处理'); }
      const remoteMap = new Map(remoteIndex.map(m => [m.id, m]));

      // 远端 pages/ 目录列表：用于发现 index 丢失的孤儿文件
      let remoteFiles = new Set();
      try {
        const entries = await dav.list('pages');
        remoteFiles = new Set(entries.filter(e => !e.isDir && e.name.endsWith('.html')).map(e => e.name));
      } catch (e) { errors.push('列远端 pages/ 失败：' + e.message); }

      const remoteDelRaw = await dav.get('deletions.json');
      let remoteDeletions = [];
      try { remoteDeletions = remoteDelRaw ? JSON.parse(remoteDelRaw.toString('utf8')) : []; } catch { /* 忽略 */ }

      // ---------- merge 下载 ----------
      let localIndex = this.hooks.loadIndex();
      const localMap = new Map(localIndex.map(m => [m.id, m]));

      for (const rm of remoteIndex) {
        if (localMap.has(rm.id)) {
          // starred 冲突：新的赢
          const lm = localMap.get(rm.id);
          if (rm.starred !== lm.starred && String(rm.starredAt || '') > String(lm.starredAt || '')) {
            lm.starred = rm.starred;
            lm.starredAt = rm.starredAt;
          }
          continue;
        }
        const html = await this.hooks.readPage(rm.id) || await this._download(dav, rm.id);
        if (html == null) { errors.push('远端页面下载失败：' + rm.id); continue; }
        this.hooks.writePage(rm.id, html);
        localIndex.push(this.hooks.normalizeMeta(rm, html));
        stats.pulled++;
      }

      // 孤儿文件自愈：pages/ 里有、index 里没有的 -> 读文件头 pv-meta 恢复
      for (const fname of remoteFiles) {
        const id = fname.replace(/\.html$/, '');
        if (localMap.has(id) || remoteMap.has(id)) continue;
        const html = await this._download(dav, id);
        if (html == null) continue;
        const meta = extractMeta(html);
        if (!meta || !meta.id) continue;
        this.hooks.writePage(id, html);
        localIndex.push(this.hooks.normalizeMeta(meta, html));
        stats.pulled++;
      }

      // ---------- 合并删除记录 ----------
      const localDeletions = this.hooks.loadDeletions();
      const delMap = new Map();
      for (const d of localDeletions.concat(remoteDeletions)) {
        if (d && d.id) delMap.set(d.id, String(d.deletedAt || ''));
      }
      let delChanged = delMap.size !== localDeletions.length;
      for (const [id] of delMap) {
        const meta = localIndex.find(m => m.id === id);
        if (meta) {
          this.hooks.deletePageFile(id);
          localIndex = localIndex.filter(m => m.id !== id);
          stats.deleted++;
          delChanged = true;
        }
      }
      if (delChanged) this.hooks.saveDeletions([...delMap].map(([id, deletedAt]) => ({ id, deletedAt })));

      // ---------- push ----------
      const afterMap = new Map(localIndex.map(m => [m.id, m]));
      for (const meta of localIndex) {
        if (remoteMap.has(meta.id) || remoteFiles.has(meta.id + '.html')) continue;
        const html = this.hooks.readPage(meta.id);
        if (html == null) { errors.push('本地页面文件缺失，跳过上传：' + meta.id); continue; }
        await dav.put('pages/' + meta.id + '.html', Buffer.from(html, 'utf8'));
        stats.pushed++;
      }
      // 清理远端残留（本地删过但远端还在的）
      for (const fname of remoteFiles) {
        const id = fname.replace(/\.html$/, '');
        if (delMap.has(id) && !afterMap.has(id)) {
          try { await dav.del('pages/' + fname); } catch { /* 远端已没有就算了 */ }
        }
      }

      this.hooks.saveIndex(localIndex);
      await dav.put('index.json', Buffer.from(JSON.stringify(localIndex, null, 2), 'utf8'));
      await dav.put('deletions.json', Buffer.from(JSON.stringify([...delMap].map(([id, deletedAt]) => ({ id, deletedAt })), null, 2), 'utf8'));

      this.state.status = 'ok';
      this.state.lastSyncAt = Date.now();
      this.state.lastError = errors.length ? errors[0] : '';
      this.state.lastStats = stats;
      if (this.hooks.onSynced) this.hooks.onSynced(stats);
      this.hooks.log('sync ok: pulled=' + stats.pulled + ' pushed=' + stats.pushed + ' deleted=' + stats.deleted + (errors.length ? ' errors=' + errors.length : ''));
      return stats;
    } catch (e) {
      errors.push(e && e.message ? e.message : String(e));
      this.state.status = 'error';
      this.state.lastError = errors[0];
      this.state.lastStats = stats;
      this.hooks.log('sync failed: ' + errors[0]);
      return stats;
    } finally {
      this.state.running = false;
      if (this.pending) { this.pending = false; setTimeout(() => this.run(cfg), 500); }
    }
  }

  async _download(dav, id) {
    try { return await dav.get('pages/' + id + '.html'); } catch { return null; }
  }

  // 定时轮询 + 变更后即时同步
  start(cfg) {
    this.stop();
    const sec = cfg && cfg.intervalSec;
    if (!sec || sec <= 0 || !cfg || !cfg.url || !cfg.user) return;
    this.timer = setInterval(() => { this.run(cfg); }, Math.max(5, sec) * 1000);
    this.hooks.log('sync timer started, interval ' + sec + 's');
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  // 本地发生变更（保存/删除/收藏）后 debounce 触发
  schedule(cfg) {
    if (!cfg || !cfg.url || !cfg.user) return;
    clearTimeout(this._deb);
    this._deb = setTimeout(() => { this.run(cfg); }, 2500);
  }
}

module.exports = { SyncEngine, extractMeta, ONLINE_WINDOW_MS };
