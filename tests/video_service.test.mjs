import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../sidecars/anchor_wheel/main.mjs';
import { PreviewService } from '../sidecars/anchor_wheel/backend/preview_service.mjs';
import {
  VideoService,
  decideVideoStrategy,
  detectMediaBinaries,
  getMediaMimeForExt,
  isAudioFilePath,
  isVideoFilePath,
  parseFfmpegStderrProbe,
  parseHttpRangeHeader,
} from '../sidecars/anchor_wheel/backend/video_service.mjs';

test('video_service recognizes wide video/audio formats, MIME fallbacks, HTTP Range parsing, and transcode strategies', () => {
  for (const name of ['clip.mov', 'movie.mkv', 'old.avi', 'stream.flv', 'win.wmv', 'cam.mts', 'disc.m2ts', 'vid.m4v', 'cell.3gp', 'clip.rmvb', 'edit.mxf', 'video.MP4']) {
    assert.equal(isVideoFilePath(name), true, `expected video: ${name}`);
  }
  assert.equal(isVideoFilePath('notes.md'), false);
  assert.equal(isAudioFilePath('voice.aac'), true);
  assert.equal(isAudioFilePath('track.opus'), true);
  assert.equal(getMediaMimeForExt('.mov'), 'video/mp4');
  assert.equal(getMediaMimeForExt('.webm'), 'video/webm');

  assert.deepEqual(parseHttpRangeHeader('bytes=0-99', 1000), { start: 0, end: 99, chunkSize: 100 });
  assert.deepEqual(parseHttpRangeHeader('bytes=900-', 1000), { start: 900, end: 999, chunkSize: 100 });
  assert.deepEqual(parseHttpRangeHeader('bytes=-50', 1000), { start: 950, end: 999, chunkSize: 50 });
  assert.equal(parseHttpRangeHeader('bytes=2000-2100', 1000).invalid, true);

  // P1-4 regression: ffmpeg -i stderr fallback accurately detects 12-bit ProRes 4444 alpha without ffprobe
  const stderrSample = `
  Duration: 00:00:15.32, start: 0.000000, bitrate: 224100 kb/s
  Stream #0:0[0x1](eng): Video: prores (4444) (ap4h / 0x68347061), yuva444p12le(tv, bt709, progressive), 960x1080, 223100 kb/s, 30 fps, 30 tbr
  Stream #0:1[0x2](eng): Audio: pcm_s16le (lpcm / 0x6D63706C), 48000 Hz, mono, s16, 768 kb/s
`;
  const parsedProbe = parseFfmpegStderrProbe(stderrSample);
  assert.equal(parsedProbe.videoCodec, 'prores');
  assert.equal(parsedProbe.pixFmt, 'yuva444p12le');
  assert.equal(parsedProbe.hasAlpha, true);
  assert.equal(parsedProbe.width, 960);
  assert.equal(parsedProbe.height, 1080);
  assert.equal(parsedProbe.fps, 30);
  assert.equal(parsedProbe.duration, 15.32);
  assert.equal(parsedProbe.audioCodec, 'pcm_s16le');

  // Direct MP4 H.264 8-bit + AAC
  assert.equal(
    decideVideoStrategy({
      ext: '.mp4',
      sizeBytes: 5_000_000,
      probe: { videoCodec: 'h264', audioCodec: 'aac', pixFmt: 'yuv420p', duration: 20 },
      hasFfmpeg: true,
    }).strategy,
    'direct'
  );

  // MOV H.264 8-bit + AAC -> fast lossless remux
  const movH264 = decideVideoStrategy({
    ext: '.mov',
    sizeBytes: 12_000_000,
    probe: { videoCodec: 'h264', audioCodec: 'aac', pixFmt: 'yuv420p', duration: 15 },
    hasFfmpeg: true,
  });
  assert.equal(movH264.strategy, 'remux');
  assert.equal(movH264.copyAudio, true);

  // MOV H.264 + PCM audio -> video copy + AAC transcode
  const movPcm = decideVideoStrategy({
    ext: '.mov',
    sizeBytes: 12_000_000,
    probe: { videoCodec: 'h264', audioCodec: 'pcm_s16le', pixFmt: 'yuv420p', duration: 15 },
    hasFfmpeg: true,
  });
  assert.equal(movPcm.strategy, 'remux');
  assert.equal(movPcm.copyAudio, false);

  // MOV ProRes 4444 alpha 12-bit -> cached transcode
  assert.equal(
    decideVideoStrategy({
      ext: '.mov',
      sizeBytes: 40_000_000,
      probe: { videoCodec: 'prores', audioCodec: 'pcm_s16le', pixFmt: 'yuva444p12le', duration: 12 },
      hasFfmpeg: true,
    }).strategy,
    'transcode_cached'
  );

  // MP4 HEVC 10-bit -> cached transcode (fixes black screen in native Chromium)
  assert.equal(
    decideVideoStrategy({
      ext: '.mp4',
      sizeBytes: 20_000_000,
      probe: { videoCodec: 'hevc', audioCodec: 'aac', pixFmt: 'yuv420p10le', duration: 30 },
      hasFfmpeg: true,
    }).strategy,
    'transcode_cached'
  );

  // Very long incompatible AVI/MKV -> live fragmented MP4 streaming
  assert.equal(
    decideVideoStrategy({
      ext: '.avi',
      sizeBytes: 900_000_000,
      probe: { videoCodec: 'mpeg4', audioCodec: 'mp3', pixFmt: 'yuv420p', duration: 3600 },
      hasFfmpeg: true,
    }).strategy,
    'transcode_live'
  );

  // Without ffmpeg on .mov -> native fallback with video/mp4 MIME
  assert.equal(
    decideVideoStrategy({
      ext: '.mov',
      sizeBytes: 5_000_000,
      probe: null,
      hasFfmpeg: false,
    }).strategy,
    'native_fallback'
  );
});

test('VideoService remuxes H.264 MOV, transcodes ProRes alpha MOV, streams HTTP 206 Range, and builds posters when ffmpeg is available', async (t) => {
  const { ffmpegBin, ffprobeBin } = detectMediaBinaries();
  if (!ffmpegBin || !ffprobeBin) {
    t.skip('ffmpeg/ffprobe not installed on this host');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-vid-svc-'));
  const wsDir = path.join(tmpRoot, 'ws');
  const dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const movH264 = path.join(wsDir, 'screen_rec.mov');
  const movProres = path.join(wsDir, 'alpha_title.mov');

  execFileSync(
    ffmpegBin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=15:duration=1.5',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-y',
      movH264,
    ],
    { windowsHide: true, timeout: 15000 }
  );

  execFileSync(
    ffmpegBin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=12:duration=1.2',
      '-c:v',
      'prores_ks',
      '-profile:v',
      '4',
      '-pix_fmt',
      'yuva444p10le',
      '-y',
      movProres,
    ],
    { windowsHide: true, timeout: 15000 }
  );

  const inst = await startServer({
    standalone: true,
    noCdp: true,
    noUpdateCheck: true,
    port: 0,
    dataDir,
    workspaceRoots: [wsDir],
  });

  const prevSvc = new PreviewService(dataDir, { ffmpegBin });

  try {
    const base = `http://127.0.0.1:${inst.port}`;

    // 1. Prepare H.264 .mov -> remuxes quickly to playable MP4
    let prep1 = await (
      await fetch(`${base}/api/media/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: movH264 }),
      })
    ).json();
    assert.equal(prep1.ok, true);
    assert.equal(prep1.strategy, 'remux');
    assert.ok(prep1.posterDataUrl.startsWith('data:image/jpeg;base64,'));
    for (let i = 0; i < 20 && !prep1.ready; i++) {
      await new Promise((r) => setTimeout(r, 150));
      prep1 = await (
        await fetch(`${base}/api/media/prepare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: movH264 }),
        })
      ).json();
    }
    assert.equal(prep1.ready, true);
    assert.equal(prep1.canInlineBlob, true);

    // 2. HTTP Range 206 streaming + token guard
    const badTok = await fetch(`${base}${prep1.relStreamUrl.replace(/token=[^&]+/, 'token=invalid')}`);
    assert.equal(badTok.status, 403);

    const rangeResp = await fetch(`${base}${prep1.relStreamUrl}`, {
      headers: { Range: 'bytes=0-255' },
    });
    assert.equal(rangeResp.status, 206);
    assert.equal(rangeResp.headers.get('content-type'), 'video/mp4');
    assert.equal(rangeResp.headers.get('accept-ranges'), 'bytes');
    assert.match(rangeResp.headers.get('content-range') || '', /^bytes 0-255\/\d+$/);
    const chunkBuf = Buffer.from(await rangeResp.arrayBuffer());
    assert.equal(chunkBuf.length, 256);

    // 3. CSP blob fallback endpoint works for cached remuxed .mov
    const blobRes = await (
      await fetch(`${base}/api/media/blob`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: movH264, mode: prep1.strategy }),
      })
    ).json();
    assert.equal(blobRes.ok, true);
    assert.equal(blobRes.mime, 'video/mp4');
    assert.ok(blobRes.base64.length > 500);

    // 4. ProRes 4444 alpha .mov -> probeVideo reports needsTranscode + transcode_cached with alpha checkerboard succeeds
    const probeProres = await (
      await fetch(`${base}/api/media/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: movProres }),
      })
    ).json();
    assert.equal(probeProres.ok, true);
    assert.equal(probeProres.needsTranscode, true);
    assert.equal(probeProres.hasAlpha, true);
    assert.equal(probeProres.strategy, 'transcode_cached');

    let prep2 = await (
      await fetch(`${base}/api/media/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: movProres }),
      })
    ).json();
    assert.equal(prep2.ok, true);
    assert.equal(prep2.strategy, 'transcode_cached');
    assert.equal(prep2.videoMeta.hasAlpha, true);
    assert.ok(prep2.relStreamUrl.includes('alpha=1'));
    for (let i = 0; i < 40 && !prep2.ready; i++) {
      await new Promise((r) => setTimeout(r, 200));
      prep2 = await (
        await fetch(`${base}/api/media/prepare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: movProres }),
        })
      ).json();
    }
    assert.equal(prep2.ready, true);
    const alphaRange = await fetch(`${base}${prep2.relStreamUrl}`, {
      headers: { Range: 'bytes=0-127' },
    });
    assert.equal(alphaRange.status, 206);
    assert.equal(alphaRange.headers.get('content-type'), 'video/mp4');

    const hoverPrev = await prevSvc.getPreview(movProres, { animated: false });
    assert.equal(hoverPrev.ok, true);
    assert.equal(hoverPrev.kind, 'video');
    assert.ok(hoverPrev.posterDataUrl.startsWith('data:image/jpeg;base64,'));
  } finally {
    prevSvc.dispose();
    await inst.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
  }
});
