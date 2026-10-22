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

function crc32(buf) {
  let c = (-1) >>> 0;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  return (c ^ (-1)) >>> 0;
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

module.exports = { zipStore, zipRead, crc32 };
