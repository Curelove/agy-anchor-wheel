import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectFfmpegBinary, PreviewService } from '../sidecars/anchor_wheel/backend/preview_service.mjs';

test('PreviewService handles text head truncation, GBK decoding, directories, small images, and path security', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-prev-'));
  const dataDir = path.join(tmpRoot, 'data');
  const wsDir = path.join(tmpRoot, 'ws');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });

  const longTxt = path.join(wsDir, 'long.md');
  const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: ` + 'x'.repeat(260));
  fs.writeFileSync(longTxt, lines.join('\n'), 'utf8');

  const gbkTxt = path.join(wsDir, 'gbk_note.txt');
  fs.writeFileSync(gbkTxt, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0x0a])); // 中文内容\n

  const svgFile = path.join(wsDir, 'icon.svg');
  fs.writeFileSync(svgFile, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>', 'utf8');

  const svc = new PreviewService(dataDir);

  try {
    const pLong = await svc.getPreview(longTxt);
    assert.equal(pLong.ok, true);
    assert.equal(pLong.kind, 'text');
    assert.equal(pLong.truncated, true);
    assert.ok(pLong.lines.length <= 18);
    assert.ok(pLong.snippetText.includes('Line 1:'));

    const pGbk = await svc.getPreview(gbkTxt);
    assert.equal(pGbk.ok, true);
    assert.equal(pGbk.kind, 'text');
    assert.equal(pGbk.snippetText, '中文内容');

    const pImg = await svc.getPreview(svgFile);
    assert.equal(pImg.ok, true);
    assert.equal(pImg.kind, 'image');
    assert.ok(pImg.dataUrl.startsWith('data:image/svg+xml;base64,'));

    const pDir = await svc.getPreview(wsDir);
    assert.equal(pDir.ok, true);
    assert.equal(pDir.kind, 'directory');
    assert.equal(pDir.itemCount, 3);

    const pUnc = await svc.getPreview('\\\\evil-host\\share\\secret.md');
    assert.equal(pUnc.ok, false);

    const pEnv = await svc.getPreview(path.join(wsDir, '.env'));
    assert.equal(pEnv.ok, false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PreviewService generates non-black video poster and cached 3s animated WebP when ffmpeg is available', async (t) => {
  const ffmpeg = detectFfmpegBinary();
  if (!ffmpeg) {
    t.skip('ffmpeg not installed on this host');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-prev-vid-'));
  const dataDir = path.join(tmpRoot, 'data');
  const wsDir = path.join(tmpRoot, 'ws');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });

  const vidPath = path.join(wsDir, 'sample_intro_black.mp4');
  // 0.6s pure black intro followed by 2.0s bright colored test pattern
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x180:d=0.6',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=15:duration=2.0',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-pix_fmt',
      'yuv420p',
      '-y',
      vidPath,
    ],
    { windowsHide: true, timeout: 10000 }
  );

  const svc = new PreviewService(dataDir, { ffmpegBin: ffmpeg });
  try {
    const first = await svc.getPreview(vidPath, { animated: true });
    assert.equal(first.ok, true);
    assert.equal(first.kind, 'video');
    assert.ok(first.posterDataUrl.startsWith('data:image/jpeg;base64,'));
    assert.equal(first.animPending, true);

    // Wait for queued animated WebP job to finish
    await Promise.all(Array.from(svc.inflightClips.values()));
    const second = await svc.getPreview(vidPath, { animated: true });
    assert.equal(second.ok, true);
    assert.equal(second.kind, 'video');
    assert.ok(second.animDataUrl.startsWith('data:image/webp;base64,'));
    assert.equal(second.animPending, false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
