/*
 * Android 二进制 XML（AXML）解析器 —— 用来在不装 Android SDK 的情况下
 * 读出 APK 里 AndroidManifest.xml 的包名、版本、minSdk/targetSdk、权限等。
 *
 * 格式说明（AOSP resource 格式，全部小端）：
 *   文件头 {u16 type=0x0003, u16 headerSize=8, u32 size}
 *   之后是一串 chunk：{u16 type, u16 headerSize, u32 chunkSize} + 数据
 *     0x0001 STRING_POOL    字符串池（UTF-8 或 UTF-16，两段式长度）
 *     0x0180 RESOURCE_MAP   属性名 → 资源 ID 映射
 *     0x0102 START_ELEMENT  元素开始
 *     0x0103 END_ELEMENT    元素结束
 * 属性优先按资源 ID 识别（跨 AAPT 版本稳定），名称只作兜底。
 */
'use strict';

const TYPE = {
  STRING_POOL: 0x0001,
  TABLE: 0x0002,
  XML: 0x0003,
  RESOURCE_MAP: 0x0180,
  START_NS: 0x0100,
  END_NS: 0x0101,
  START_ELEMENT: 0x0102,
  END_ELEMENT: 0x0103,
  CDATA: 0x0104
};

/* android: 属性的资源 ID（AOSP public.xml） */
const ATTR = {
  0x01010003: 'name',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x0101020c: 'minSdkVersion',
  0x01010270: 'targetSdkVersion',
  0x01010001: 'label',
  0x01010000: 'theme',
  0x0101026c: 'screenOrientation'
};

const VALUE_TYPE = {
  0x00: 'null', 0x01: 'reference', 0x02: 'attribute', 0x03: 'string',
  0x04: 'float', 0x10: 'int', 0x11: 'hex', 0x12: 'boolean'
};

function readStringPool(buf, pos, headerSize, chunkSize) {
  const count = buf.readUInt32LE(pos + 8);
  const flags = buf.readUInt32LE(pos + 16);
  const stringsStart = buf.readUInt32LE(pos + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = buf.readUInt32LE(pos + headerSize + i * 4);
    let p = pos + stringsStart + off;
    if (p < 0 || p >= buf.length) throw new Error('字符串池第 ' + i + ' 项偏移越界');
    if (utf8) {
      let n = buf[p++];
      if (n & 0x80) n = ((n & 0x7f) << 8) | buf[p++];
      let m = buf[p++];
      if (m & 0x80) m = ((m & 0x7f) << 8) | buf[p++];
      out.push(buf.toString('utf8', p, p + m));
    } else {
      let n = buf.readUInt16LE(p); p += 2;
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
      out.push(buf.toString('utf16le', p, p + n * 2));
    }
  }
  return { utf8, strings: out, count };
}

function parse(buf) {
  if (buf.length < 8) throw new Error('文件太小，不是 AXML');
  const type = buf.readUInt16LE(0);
  if (type !== TYPE.XML) throw new Error('文件头不是 XML chunk（读到 0x' + type.toString(16) + '）');
  const fileSize = Math.min(buf.readUInt32LE(4) || buf.length, buf.length);

  let pos = buf.readUInt16LE(2);           // = 8
  let pool = null, resMap = null;
  const events = [];

  while (pos + 8 <= fileSize) {
    const ctype = buf.readUInt16LE(pos);
    const headerSize = buf.readUInt16LE(pos + 2);
    const chunkSize = buf.readUInt32LE(pos + 4);
    if (chunkSize <= 0 || pos + chunkSize > buf.length) throw new Error('chunk 0x' + ctype.toString(16) + ' 长度异常');
    const str = i => {
      if (!pool) throw new Error('遇到 ' + i + ' 号字符串但还没有字符串池');
      const s = pool.strings[i];
      if (s === undefined) throw new Error('字符串索引 ' + i + ' 越界');
      return s;
    };

    if (ctype === TYPE.STRING_POOL) {
      pool = readStringPool(buf, pos, headerSize, chunkSize);
    } else if (ctype === TYPE.RESOURCE_MAP) {
      resMap = [];
      const n = (chunkSize - headerSize) / 4;
      for (let i = 0; i < n; i++) resMap.push(buf.readUInt32LE(pos + headerSize + i * 4));
    } else if (ctype === TYPE.START_ELEMENT) {
      const nameIdx = buf.readUInt32LE(pos + 20);
      const attrStart = buf.readUInt16LE(pos + 24);
      const attrCount = buf.readUInt16LE(pos + 28);
      const attrs = [];
      for (let i = 0; i < attrCount; i++) {
        const p = pos + 16 + attrStart + i * 20;
        if (p + 20 > buf.length) throw new Error('属性越界');
        const nsIdx = buf.readUInt32LE(p);
        const aNameIdx = buf.readUInt32LE(p + 4);
        const rawIdx = buf.readUInt32LE(p + 8);
        const dataType = buf.readUInt8(p + 15);
        const data = buf.readUInt32LE(p + 16);
        const resId = resMap && resMap[aNameIdx] ? resMap[aNameIdx] : 0;
        let value;
        if (dataType === 0x03) value = str(data);
        else if (dataType === 0x10) value = data | 0;
        else if (dataType === 0x12) value = data !== 0;
        else if (dataType === 0x01) value = '@ref/0x' + data.toString(16);
        else value = data;
        attrs.push({
          name: ATTR[resId] || str(aNameIdx),
          rawName: str(aNameIdx),
          ns: nsIdx >= 0 && pool.strings[nsIdx] ? pool.strings[nsIdx] : '',
          resourceId: resId,
          type: VALUE_TYPE[dataType] || ('0x' + dataType.toString(16)),
          raw: rawIdx >= 0 && pool.strings[rawIdx] ? pool.strings[rawIdx] : null,
          value
        });
      }
      events.push({ kind: 'start', name: str(nameIdx), attrs });
    } else if (ctype === TYPE.END_ELEMENT) {
      events.push({ kind: 'end', name: str(buf.readUInt32LE(pos + 20)) });
    }
    pos += chunkSize;
  }
  return { pool, resMap, events };
}

/* 把事件流整理成一棵元素树 */
function buildTree(parsed) {
  const root = { name: '#document', children: [], attrs: [] };
  const stack = [root];
  for (const e of parsed.events) {
    if (e.kind === 'start') {
      const node = { name: e.name, attrs: e.attrs, children: [], parent: stack[stack.length - 1] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  return root;
}

const attr = (node, name) => {
  const a = (node.attrs || []).find(x => x.name === name);
  return a ? a.value : undefined;
};
const find = (node, name) => (node.children || []).find(c => c.name === name);
const findAll = (node, name) => (node.children || []).filter(c => c.name === name);

/* 汇总出关心的清单信息 */
function summarize(buf) {
  const parsed = parse(buf);
  const root = buildTree(parsed);
  const manifest = find(root, 'manifest');
  if (!manifest) throw new Error('清单里找不到 <manifest> 根元素');

  const usesSdk = find(manifest, 'uses-sdk');
  const app = find(manifest, 'application');
  const permissions = findAll(manifest, 'uses-permission')
    .map(n => attr(n, 'name'))
    .filter(Boolean);

  const activities = findAll(manifest, 'activity').map(a => {
    const filters = findAll(a, 'intent-filter');
    const actions = [], categories = [];
    for (const f of filters) {
      for (const x of findAll(f, 'action')) actions.push(attr(x, 'name'));
      for (const x of findAll(f, 'category')) categories.push(attr(x, 'name'));
    }
    return {
      name: attr(a, 'name'),
      exported: attr(a, 'exported'),
      configChanges: attr(a, 'configChanges'),
      actions: actions.filter(Boolean),
      categories: categories.filter(Boolean),
      isLauncher: actions.includes('android.intent.action.MAIN') &&
        categories.includes('android.intent.category.LAUNCHER')
    };
  });

  return {
    package: attr(manifest, 'package'),
    versionCode: attr(manifest, 'versionCode'),
    versionName: attr(manifest, 'versionName'),
    minSdk: usesSdk ? attr(usesSdk, 'minSdkVersion') : undefined,
    targetSdk: usesSdk ? attr(usesSdk, 'targetSdkVersion') : undefined,
    permissions,
    activities,
    application: app ? { label: attr(app, 'label'), icon: attr(app, 'icon'), allowBackup: attr(app, 'allowBackup') } : null,
    hasLauncher: activities.some(a => a.isLauncher),
    stringPoolIsUtf8: parsed.pool ? parsed.pool.utf8 : null,
    elementCount: parsed.events.filter(e => e.kind === 'start').length
  };
}

module.exports = { parse, buildTree, summarize, ATTR, TYPE };
