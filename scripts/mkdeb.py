#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一棵已排好版的目录树打成 Debian 包（.deb），不需要 dpkg-deb。

为什么自己写：构建机是 macOS（Homebrew 的 dpkg 在沙箱里装不上），而 .deb 的
容器格式极其简单——一个 ar 归档里放三段：
    debian-binary   内容 "2.0\\n"
    control.tar.gz  ./control ./md5sums
    data.tar.gz     真实的文件树（路径以 ./ 开头）
直接在 Python 里生成比装工具链稳定。Linux 上若有 dpkg-deb，打包脚本会优先用它。

用法：
    mkdeb.py --root <stage_dir> --package webvault --version 1.4.0 --arch amd64 \
             --output out.deb --depends "libgtk-3-0, libnss3" \
             --maintainer "x <x@y>" --summary "一句话" --description-file desc.txt

--root 里的内容是**相对根**的路径（opt/... usr/...），原样进 data.tar.gz。
权限按源文件读，属主统一 root:root（等价 dpkg-deb --root-owner-group）。
"""

import argparse
import gzip
import hashlib
import io
import os
import stat
import tarfile

AR_MAGIC = b'!<arch>\n'
MTIME = int(os.environ.get('SOURCE_DATE_EPOCH', '1700000000'))


def gz(data, level):
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode='wb', compresslevel=level, mtime=0) as f:
        f.write(data)
    return out.getvalue()


def add_file(tf, name, data, mode):
    ti = tarfile.TarInfo(name)
    ti.size = len(data)
    ti.mode = mode
    ti.mtime = MTIME
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = 'root'
    tf.addfile(ti, io.BytesIO(data))


def add_dir(tf, name, mode=0o755):
    ti = tarfile.TarInfo(name)
    ti.type = tarfile.DIRTYPE
    ti.mode = mode
    ti.mtime = MTIME
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = 'root'
    tf.addfile(ti)


def add_link(tf, name, target):
    ti = tarfile.TarInfo(name)
    ti.type = tarfile.SYMTYPE
    ti.linkname = target
    ti.mode = 0o777
    ti.mtime = MTIME
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = 'root'
    tf.addfile(ti)


def build_data_tar(root, mode_overrides=None):
    """生成 data.tar.gz 字节；同时返回 (md5sums 列表, 总字节数)。

    mode_overrides: {相对路径: mode}，用于强制权限。
    必须走这条路而不是事先 chmod：macOS 沙箱里 chmod 4755 **返回成功但权限不变**，
    结果打出来的包 chrome-sandbox 没有 setuid，装完 Chromium 沙箱起不来。
    直接写进 tar 头才靠得住。
    """
    mode_overrides = mode_overrides or {}
    items = []          # (相对路径, kind, payload, mode)
    sums = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        filenames.sort()
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir != '.':
            items.append((rel_dir.replace(os.sep, '/'), 'dir', None, None))
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode):
                items.append((rel, 'link', os.readlink(full), None))
            else:
                with open(full, 'rb') as f:
                    data = f.read()
                mode = mode_overrides.get(rel, stat.S_IMODE(st.st_mode))
                items.append((rel, 'file', data, mode))
                sums.append((rel, hashlib.md5(data).hexdigest()))
                total += len(data)

    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.GNU_FORMAT) as tf:
        add_dir(tf, './')
        for rel, kind, payload, mode in items:
            if kind == 'dir':
                add_dir(tf, './' + rel)
            elif kind == 'link':
                add_link(tf, './' + rel, payload)
            else:
                add_file(tf, './' + rel, payload, mode)
    return gz(raw.getvalue(), 6), sums, total


def build_control_tar(control, sums, postinst=None):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.GNU_FORMAT) as tf:
        add_dir(tf, './')
        add_file(tf, './control', control.encode('utf-8'), 0o644)
        if sums:
            md5s = ''.join('%s  %s\n' % (h, p) for p, h in sums)
            add_file(tf, './md5sums', md5s.encode('utf-8'), 0o644)
        if postinst:
            add_file(tf, './postinst', postinst.encode('utf-8'), 0o755)
    return gz(raw.getvalue(), 9)


def render_control(fields, summary, body_lines):
    """Debian control：普通字段一行一个，Description 支持续行（以空格开头，空行写成 .）"""
    out = []
    for k, v in fields:
        out.append('%s: %s' % (k, v))
    out.append('Description: %s' % summary)
    for ln in body_lines:
        out.append((' ' + ln) if ln.strip() else ' .')
    return '\n'.join(out) + '\n'


def ar_member(name, data):
    """ar 成员头正好 60 字节；奇数长度补一个 \\n。"""
    if len(name) > 16:
        raise ValueError('ar 成员名不能超过 16 字节: ' + name)
    head = '%-16s%-12s%-6s%-6s%-8s%-10s`\n' % (name, MTIME, '0', '0', '100644', len(data))
    assert len(head) == 60, len(head)
    pad = b'\n' if len(data) % 2 else b''
    return head.encode('ascii') + data + pad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--package', required=True)
    ap.add_argument('--version', required=True)
    ap.add_argument('--arch', default='amd64')
    ap.add_argument('--output', required=True)
    ap.add_argument('--depends', default='')
    ap.add_argument('--recommends', default='')
    ap.add_argument('--maintainer', default='feibixunchang <feibixunchang@users.noreply.github.com>')
    ap.add_argument('--section', default='utils')
    ap.add_argument('--priority', default='optional')
    ap.add_argument('--homepage', default='https://github.com/feibixunchang/pagevault')
    ap.add_argument('--summary', default='Web page archiver with multi-device sync')
    ap.add_argument('--description-file', default='')
    ap.add_argument('--postinst-file', default='')
    # 形如 --mode opt/WebVault/chrome-sandbox=4755，可重复
    ap.add_argument('--mode', action='append', default=[])
    args = ap.parse_args()

    overrides = {}
    for spec in args.mode:
        if '=' not in spec:
            raise SystemExit('--mode 需要 路径=八进制权限，例如 opt/x=4755')
        rel, val = spec.rsplit('=', 1)
        overrides[rel.lstrip('./')] = int(val, 8)

    data_tar, sums, total = build_data_tar(args.root, overrides)

    body = []
    if args.description_file and os.path.exists(args.description_file):
        with open(args.description_file, 'r', encoding='utf-8') as f:
            body = f.read().rstrip().splitlines()

    postinst = None
    if args.postinst_file and os.path.exists(args.postinst_file):
        with open(args.postinst_file, 'r', encoding='utf-8') as f:
            postinst = f.read()

    fields = [
        ('Package', args.package),
        ('Version', args.version),
        ('Section', args.section),
        ('Priority', args.priority),
        ('Architecture', args.arch),
        ('Maintainer', args.maintainer),
        ('Installed-Size', str(max(1, total // 1024))),
    ]
    if args.depends:
        fields.append(('Depends', args.depends))
    if args.recommends:
        fields.append(('Recommends', args.recommends))
    fields.append(('Homepage', args.homepage))

    control = render_control(fields, args.summary, body)
    control_tar = build_control_tar(control, sums, postinst)

    out_bytes = b''.join([
        AR_MAGIC,
        ar_member('debian-binary', b'2.0\n'),
        ar_member('control.tar.gz', control_tar),
        ar_member('data.tar.gz', data_tar),
    ])
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, 'wb') as f:
        f.write(out_bytes)
    print('deb: %s (%.1f MB, %d files)' % (args.output, len(out_bytes) / 1048576, len(sums)))


if __name__ == '__main__':
    main()
