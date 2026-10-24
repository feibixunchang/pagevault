'use strict';

// 极简 ZIP（store 模式，不压缩）—— 用于整库导出 / 导入备份。
// 为什么不用压缩库：项目保持零依赖；SingleFile 产出的 HTML 本身就是高度优化过的，
// zip 在这里只当打包容器用；store 模式实现简单，系统自带解压工具和本模块都能读。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

// 中间态（未做首尾取反），便于分块累计：大文件不可能一次性读进内存
function crc32Update(c, buf) {
  let v = c >>> 0;
  for (let i = 0; i < buf.length; i++) v = (CRC_TABLE[(v ^ buf[i]) & 0xFF] ^ (v >>> 8)) >>> 0;
  return v >>> 0;
}

function crc32(buf) {
  return (crc32Update(0xFFFFFFFF, buf) ^ 0xFFFFFFFF) >>> 0;
}

const DOS_TIME = 0x6000; // 12:00:00
const DOS_DATE = 0x2921; // 2024-09-01（固定合法值，避免 0 被某些解压器拒绝）

// files: [{ name: 'pages/xxx.html', data: Buffer }] -> Buffer(zip)
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header 签名
    lh.writeUInt16LE(20, 4);           // 需要的版本
    lh.writeUInt16LE(0x0800, 6);       // UTF-8 文件名标志
    lh.writeUInt16LE(0, 8);            // store
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);   // central directory 签名
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(f.data.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);           // extra len
    cd.writeUInt16LE(0, 32);           // comment len
    cd.writeUInt16LE(0, 34);           // disk number
    cd.writeUInt16LE(0, 36);           // internal attrs
    cd.writeUInt32LE(0, 38);           // external attrs
    cd.writeUInt32LE(offset, 42);      // local header 偏移
    central.push(Buffer.concat([cd, nameBuf]));

    offset += 30 + nameBuf.length + f.data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);            // disk number
  eocd.writeUInt16LE(0, 6);            // cd start disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);      // cd 偏移
  eocd.writeUInt16LE(0, 20);           // comment len
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// zipBuf -> [{ name, data: Buffer }]
// 只支持 store 模式、无 data descriptor 的条目（即本模块生成 / 常见工具产物）。
function zipRead(zipBuf) {
  const out = [];
  let pos = 0;
  while (pos + 30 <= zipBuf.length && zipBuf.readUInt32LE(pos) === 0x04034b50) {
    const flag = zipBuf.readUInt16LE(pos + 6);
    const method = zipBuf.readUInt16LE(pos + 8);
    const crc = zipBuf.readUInt32LE(pos + 14);
    const compSize = zipBuf.readUInt32LE(pos + 18);
    const nameLen = zipBuf.readUInt16LE(pos + 26);
    const extraLen = zipBuf.readUInt16LE(pos + 28);
    const name = zipBuf.toString('utf8', pos + 30, pos + 30 + nameLen);
    const dataStart = pos + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('压缩条目暂不支持（请使用本工具导出的备份）：' + name);
    if (flag & 0x08) throw new Error('流式条目暂不支持：' + name);
    if (dataStart + compSize > zipBuf.length) throw new Error('zip 文件损坏或已截断');
    const data = Buffer.from(zipBuf.subarray(dataStart, dataStart + compSize));
    if (crc32(data) !== crc) throw new Error('校验失败（CRC 不匹配）：' + name);
    out.push({ name, data });
    pos = dataStart + compSize;
  }
  if (!out.length) throw new Error('zip 里没有找到任何文件');
  return out;
}

module.exports = { zipStore, zipStoreStream, zipRead, crc32 };

// ---------------------------------------------------------------------------
// 流式导出
//
// zipStore() 会在内存里拼出完整的 zip：库到几个 G 的时候，Node 的 Buffer 上限
// （2GB）直接崩，进程也跟着挂。整库导出是一次性动作，没必要为它兜住整份数据，
// 所以这里改成「先扫一遍拿 size/crc，再一遍把内容冲进响应」——内存占用恒定在
// 一个 64KB 的块。
//
// 代价是每个文件读两次。对磁盘来说这比内存峰值重要得多。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const CHUNK = 64 * 1024;
const MAX_ENTRY = 0xFFFFFFFF - 1; // ZIP64 之前，单个条目理论上限 4GB

/** 扫一个文件：拿 size 和 crc（顺带就校验了可读性） */
async function scanFile(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('不是文件：' + file);
    if (st.size > MAX_ENTRY) throw new Error('单个文件超过 4GB，暂不支持打包：' + path.basename(file));
    const buf = Buffer.allocUnsafe(CHUNK);
    let c = 0xFFFFFFFF;
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      c = crc32Update(c, buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return { size: st.size, crc: (c ^ 0xFFFFFFFF) >>> 0 };
  } finally {
    await fh.close().catch(() => {});
  }
}

// 等可写流消化完，再喂下一块；否则大库会把内存堆回原样
function writeChunk(out, buf) {
  return new Promise((resolve, reject) => {
    if (out.destroyed || out.writableEnded) return reject(new Error('连接已断开'));
    if (out.write(buf)) return resolve();
    const onDrain = () => { out.removeListener('error', onErr); out.removeListener('close', onClose); resolve(); };
    const onErr = (e) => { out.removeListener('drain', onDrain); out.removeListener('close', onClose); reject(e); };
    const onClose = () => { out.removeListener('drain', onDrain); out.removeListener('error', onErr); reject(new Error('连接已断开')); };
    out.once('drain', onDrain);
    out.once('error', onErr);
    out.once('close', onClose);
  });
}

/**
 * 把条目流式写进一个可写流（http 的 res）。
 * entries: [{ name, path?, data? }]，path 优先；两个都没有视为空文件。
 * 返回写出的总字节数。
 */
async function zipStoreStream(out, entries, onProgress) {
  const local = [];   // [header, nameBuf, size, offset]
  const central = [];
  let offset = 0;

  for (const en of entries) {
    const nameBuf = Buffer.from(en.name, 'utf8');
    let size, crc;
    if (en.path) {
      const info = await scanFile(en.path);
      size = info.size; crc = info.crc;
    } else {
      const d = en.data || Buffer.alloc(0);
      size = d.length; crc = crc32(d);
    }
    if (offset + 30 + nameBuf.length + size > MAX_ENTRY) {
      throw new Error('备份总大小超过 4GB，暂不支持单个 zip（可以分批导出）');
    }

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);       // UTF-8 文件名
    lh.writeUInt16LE(0, 8);            // store
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    await writeChunk(out, lh);
    await writeChunk(out, nameBuf);
    offset += 30 + nameBuf.length;

    if (en.path) {
      // 一次读一块写一块，绝不整份进内存
      const fh = await fs.promises.open(en.path, 'r');
      try {
        const buf = Buffer.allocUnsafe(CHUNK);
        let pos = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
          if (!bytesRead) break;
          await writeChunk(out, buf.subarray(0, bytesRead));
          pos += bytesRead;
        }
      } finally {
        await fh.close().catch(() => {});
      }
    } else if (en.data && en.data.length) {
      await writeChunk(out, en.data);
    }
    offset += size;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset - size - 30 - nameBuf.length, 42); // local header 偏移
    central.push(Buffer.concat([cd, nameBuf]));

    if (onProgress) onProgress(en.name, size);
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  await writeChunk(out, cdBuf);
  await writeChunk(out, eocd);
  return offset + cdBuf.length + 22;
}
