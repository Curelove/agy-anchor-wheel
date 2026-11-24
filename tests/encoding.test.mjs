import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFileToUtf8, decodeBuffer, detectEncoding, inspectFileEncoding } from '../sidecars/anchor_wheel/backend/encoding.mjs';

function encodeGbkOrGb18030Bytes(str) {
  // Hand-crafted real GBK byte sequences for "中文测试报告" + ASCII
  // 中 = D6 D0, 文 = CE C4, 测 = B2 E2, 试 = CA D4, 报 = B1 A8, 告 = B8 E6
  return Buffer.concat([
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xb1, 0xa8, 0xb8, 0xe6]),
    Buffer.from(' - GBK OK\n', 'ascii'),
  ]);
}

test('detects UTF-8, UTF-8 BOM, and UTF-16LE/BE cleanly', () => {
  const utf8 = Buffer.from('# 标题\n这是标准的 UTF-8 中文文档。\n', 'utf8');
  assert.equal(detectEncoding(utf8).encoding, 'utf-8');
  assert.equal(decodeBuffer(utf8).isNonUtf8, false);

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
  assert.equal(detectEncoding(bom).encoding, 'utf-8-bom');
  assert.equal(decodeBuffer(bom).text.startsWith('# 标题'), true);

  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hello 锚点轮盘\n', 'utf16le')]);
  assert.equal(detectEncoding(utf16le).encoding, 'utf-16le');
  assert.equal(decodeBuffer(utf16le).text, 'Hello 锚点轮盘\n');
  assert.equal(decodeBuffer(utf16le).isNonUtf8, true);
});

test('detects and decodes GBK/GB18030 Chinese text without replacement mojibake', () => {
  const gbkBuf = encodeGbkOrGb18030Bytes();
  const det = detectEncoding(gbkBuf);
  assert.ok(det.encoding === 'gb18030' || det.encoding === 'gbk', `unexpected encoding: ${det.encoding}`);
  const dec = decodeBuffer(gbkBuf);
  assert.equal(dec.isNonUtf8, true);
  assert.equal(dec.text, '中文测试报告 - GBK OK\n');
});

test('detects Shift-JIS Japanese text accurately', () => {
  // "テスト文書" in Shift-JIS: テ=83 65, ス=83 58, ト=83 67, 文=95 B6, 書=8F 91
  const sjis = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x95, 0xb6, 0x8f, 0x91]);
  const det = detectEncoding(sjis);
  assert.equal(det.encoding, 'shift_jis');
  assert.equal(decodeBuffer(sjis).text, 'テスト文書');
});

test('convertFileToUtf8 preserves .bak.encoding backup and converts atomically', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-enc-'));
  try {
    const file = path.join(tmpDir, 'legacy_gbk.txt');
    const raw = encodeGbkOrGb18030Bytes();
    fs.writeFileSync(file, raw);

    const inspected = inspectFileEncoding(file);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.isNonUtf8, true);
    assert.equal(inspected.text, '中文测试报告 - GBK OK\n');

    const conv = convertFileToUtf8(file);
    assert.equal(conv.ok, true);
    assert.equal(conv.alreadyUtf8, false);
    assert.ok(fs.existsSync(conv.backupPath));
    assert.deepEqual(fs.readFileSync(conv.backupPath), raw);
    assert.equal(fs.readFileSync(file, 'utf8'), '中文测试报告 - GBK OK\n');
    assert.equal(detectEncoding(fs.readFileSync(file)).encoding, 'utf-8');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('blocks sensitive credential files from encoding inspection', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-sec-'));
  try {
    const envFile = path.join(tmpDir, '.env');
    fs.writeFileSync(envFile, 'SECRET=123\n');
    const res = inspectFileEncoding(envFile);
    assert.equal(res.ok, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('does not misclassify truncated multi-byte UTF-8 Chinese slices as legacy GB18030', () => {
  const fullBuf = Buffer.from('这是一段标准的中文测试文档，用来验证截断到多字节字符中间时不会误报乱码。', 'utf8');
  // Cut 1 byte off the last 3-byte Chinese character
  const cut1 = fullBuf.subarray(0, fullBuf.length - 1);
  const cut2 = fullBuf.subarray(0, fullBuf.length - 2);
  for (const slice of [cut1, cut2]) {
    const det = detectEncoding(slice, { truncated: true });
    assert.equal(det.encoding, 'utf-8');
    const dec = decodeBuffer(slice, '', { truncated: true });
    assert.equal(dec.isNonUtf8, false);
    assert.equal(dec.mojibakeHint, false);
    assert.equal(dec.text.includes('\uFFFD'), false);
  }
});
