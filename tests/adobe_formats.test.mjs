import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { openExternalDocument, renderDocument } from '../sidecars/anchor_wheel/backend/document_renderer.mjs';
import { PreviewService } from '../sidecars/anchor_wheel/backend/preview_service.mjs';

function makeMinimalZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = zlib.crc32 ? zlib.crc32(raw) >>> 0 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function makeSyntheticPsd() {
  // 26-byte header: 8BPS, v1, 4 channels, 1080h x 1920w, 8-bit, RGB (3)
  const hdr = Buffer.alloc(26);
  hdr.write('8BPS', 0, 'latin1');
  hdr.writeUInt16BE(1, 4);
  hdr.writeUInt16BE(4, 12);
  hdr.writeUInt32BE(1080, 14);
  hdr.writeUInt32BE(1920, 18);
  hdr.writeUInt16BE(8, 22);
  hdr.writeUInt16BE(3, 24);

  // Color mode data: 0 bytes
  const colorLen = Buffer.alloc(4);

  // Image Resources: 0x03ED (DPI 300), 0x040C (JPEG thumb), 0x0424 (XMP)
  const dpiData = Buffer.alloc(16);
  dpiData.writeUInt32BE(300 * 65536, 0);
  dpiData.writeUInt32BE(300 * 65536, 8);
  const resDpi = build8BimRes(0x03ed, dpiData);

  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(48, 0x2a), Buffer.from([0xff, 0xd9])]);
  const thumbHdr = Buffer.alloc(28);
  thumbHdr.writeUInt32BE(1, 0); // kJpegRGB
  thumbHdr.writeUInt32BE(160, 4);
  thumbHdr.writeUInt32BE(90, 8);
  const resThumb = build8BimRes(0x040c, Buffer.concat([thumbHdr, fakeJpeg]));

  const xmpXml = Buffer.from(
    '<x:xmpmeta><rdf:RDF><rdf:Description xmp:CreatorTool="Adobe Photoshop 25.0" photoshop:ICCProfile="sRGB IEC61966-2.1"><stFnt:fontName>SourceHanSansCN-Bold</stFnt:fontName></rdf:Description></rdf:RDF></x:xmpmeta>',
    'utf8'
  );
  const resXmp = build8BimRes(0x0424, xmpXml);

  const resBody = Buffer.concat([resDpi, resThumb, resXmp]);
  const resLen = Buffer.alloc(4);
  resLen.writeUInt32BE(resBody.length, 0);

  // Layer Info: 1 Unicode layer "主角立绘" (Multiply, 85%, visible)
  const uniName = '主角立绘';
  const uniBuf = Buffer.alloc(4 + uniName.length * 2);
  uniBuf.writeUInt32BE(uniName.length, 0);
  for (let i = 0; i < uniName.length; i++) uniBuf.writeUInt16BE(uniName.charCodeAt(i), 4 + i * 2);
  const luniBlock = Buffer.concat([
    Buffer.from('8BIMluni', 'latin1'),
    u32be(uniBuf.length),
    uniBuf,
    uniBuf.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
  // Extra data: maskLen(4)=0, rangesLen(4)=0, pascalName(4)=[0,0,0,0], luniBlock
  const extraData = Buffer.concat([Buffer.alloc(8), Buffer.alloc(4), luniBlock]);
  const lyrRec = Buffer.alloc(18 + 16);
  lyrRec.writeInt32BE(10, 0);
  lyrRec.writeInt32BE(20, 4);
  lyrRec.writeInt32BE(510, 8);
  lyrRec.writeInt32BE(620, 12);
  lyrRec.writeUInt16BE(0, 16); // 0 channels for compact fixture
  lyrRec.write('8BIMmul ', 18, 'latin1');
  lyrRec[26] = 217; // ~85%
  lyrRec[28] = 0x00; // visible
  lyrRec.writeUInt32BE(extraData.length, 30);

  const layerInfoInner = Buffer.concat([i16be(1), lyrRec, extraData]);
  const layerSectionBody = Buffer.concat([u32be(layerInfoInner.length), layerInfoInner]);
  const layerSectionLen = u32be(layerSectionBody.length);

  return Buffer.concat([hdr, colorLen, resLen, resBody, layerSectionLen, layerSectionBody]);
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}
function i16be(n) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n, 0);
  return b;
}
function build8BimRes(id, data) {
  const hdr = Buffer.alloc(12);
  hdr.write('8BIM', 0, 'latin1');
  hdr.writeUInt16BE(id, 4);
  hdr.writeUInt16BE(0, 6); // empty pascal name padded to 2 bytes
  hdr.writeUInt32BE(data.length, 8);
  return Buffer.concat([hdr, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function makeRifxChunk(tag, payload) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([Buffer.from(tag, 'latin1'), u32be(b.length), b, b.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function makeRifxList(sub, children) {
  return makeRifxChunk('LIST', Buffer.concat([Buffer.from(sub, 'latin1'), ...children]));
}

function makeSyntheticAep() {
  const idtaComp = Buffer.alloc(4);
  idtaComp.writeUInt16BE(4, 0);
  const cdta = Buffer.alloc(164);
  cdta.writeUInt32BE(307200, 44);
  cdta.writeUInt32BE(30720, 48); // 10s
  cdta.writeUInt16BE(1920, 140);
  cdta.writeUInt16BE(1080, 142);
  cdta.writeUInt32BE(60 * 65536, 156); // 60 fps

  const layr = makeRifxList('Layr', [
    makeRifxChunk('Utf8', '主标题文字层'),
    makeRifxChunk('Utf8', 'var p = thisComp.layer("控制层").transform.position;\nlinear(time, 0, 1, p, [960, 540]);'),
  ]);
  const compItem = makeRifxList('Item', [
    makeRifxChunk('idta', idtaComp),
    makeRifxChunk('Utf8', '片头主合成'),
    makeRifxChunk('cdta', cdta),
    layr,
  ]);
  const idtaFoot = Buffer.alloc(4);
  idtaFoot.writeUInt16BE(7, 0);
  const footItem = makeRifxList('Item', [
    makeRifxChunk('idta', idtaFoot),
    makeRifxChunk('Utf8', 'bg_loop.mov'),
    makeRifxList('Pin ', [
      makeRifxList('Als2', [
        makeRifxChunk('alas', '{"fullpath":"/Users/demo/assets/bg_loop.mov"}'),
      ]),
    ]),
  ]);
  const fold = makeRifxList('Fold', [compItem, footItem]);
  const rifxBody = Buffer.concat([Buffer.from('Egg!', 'latin1'), fold]);
  const rifx = makeRifxChunk('RIFX', rifxBody);
  const xmpTail = Buffer.from('<?xpacket begin="" id="W5M0"?><x:xmpmeta><rdf:RDF><rdf:Description xmp:CreatorTool="Adobe After Effects 25.2"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>', 'utf8');
  return Buffer.concat([rifx, xmpTail]);
}

test('Adobe decoders parse PSD, AEP, PRPROJ, AI (PDF & EPS), MOGRT, PRTEXTSTYLE, SESX, INDD, and CUBE cleanly', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-adobe-'));
  const dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const prevSvc = new PreviewService(dataDir, { ffmpegBin: '' });

  try {
    // 1. PSD
    const psdPath = path.join(tmpRoot, 'poster.psd');
    fs.writeFileSync(psdPath, makeSyntheticPsd());
    const psdRes = renderDocument(psdPath);
    assert.equal(psdRes.ok, true);
    assert.equal(psdRes.format, 'adobe');
    assert.equal(psdRes.badge, 'PSD');
    assert.ok(psdRes.previewThumbDataUrl.startsWith('data:image/jpeg;base64,'));
    assert.ok(psdRes.bodyHtml.includes('1920 × 1080 px'));
    assert.ok(psdRes.bodyHtml.includes('300 DPI'));
    assert.ok(psdRes.bodyHtml.includes('主角立绘'));
    assert.ok(psdRes.bodyHtml.includes('正片叠底'));
    assert.ok(psdRes.bodyHtml.includes('SourceHanSansCN-Bold'));

    // Hover preview card also receives embedded PSD thumbnail
    const psdHover = await prevSvc.getPreview(psdPath);
    assert.equal(psdHover.ok, true);
    assert.equal(psdHover.kind, 'document');
    assert.ok(psdHover.dataUrl.startsWith('data:image/jpeg;base64,'));

    // 2. AEP (fd-seeking RIFX + tail XMP + 0-byte guard)
    const aepPath = path.join(tmpRoot, 'intro.aep');
    fs.writeFileSync(aepPath, makeSyntheticAep());
    const aepRes = renderDocument(aepPath);
    assert.equal(aepRes.ok, true);
    assert.equal(aepRes.badge, 'AEP');
    assert.ok(aepRes.bodyHtml.includes('片头主合成'));
    assert.ok(aepRes.bodyHtml.includes('1920×1080'));
    assert.ok(aepRes.bodyHtml.includes('60 fps'));
    assert.ok(aepRes.bodyHtml.includes('bg_loop.mov'));
    assert.ok(aepRes.bodyHtml.includes('linear(time'));
    assert.ok(aepRes.bodyHtml.includes('Adobe After Effects 25.2'));

    const emptyAep = path.join(tmpRoot, 'empty.aep');
    fs.writeFileSync(emptyAep, Buffer.alloc(0));
    const emptyRes = renderDocument(emptyAep);
    assert.equal(emptyRes.ok, false);
    assert.match(emptyRes.error, /空文件/);

    // 3. PRPROJ (gzipped XML)
    const prXml = `<?xml version="1.0" encoding="UTF-8"?><PremiereData Version="3"><Project ObjectID="1" Version="43"></Project><Sequence ObjectID="2"><FrameRect>0,0,1920,1080</FrameRect><FrameRate>8467200000</FrameRate><Name>主剪辑序列</Name></Sequence><VideoClipTrack ObjectID="3"/><AudioClipTrack ObjectID="4"/><ActualMediaFilePath>/Users/demo/footage/shot01.mov</ActualMediaFilePath><ActualMediaFilePath>/Users/demo/audio/bgm.wav</ActualMediaFilePath></PremiereData>`;
    const prPath = path.join(tmpRoot, 'edit.prproj');
    fs.writeFileSync(prPath, zlib.gzipSync(Buffer.from(prXml, 'utf8')));
    const prRes = renderDocument(prPath);
    assert.equal(prRes.ok, true);
    assert.equal(prRes.badge, 'PRPROJ');
    assert.ok(prRes.bodyHtml.includes('Premiere Pro 2025'));
    assert.ok(prRes.bodyHtml.includes('主剪辑序列'));
    assert.ok(prRes.bodyHtml.includes('30 fps'));
    assert.ok(prRes.bodyHtml.includes('shot01.mov'));
    assert.ok(prRes.bodyHtml.includes('bgm.wav'));

    // 4. AI (PDF-compatible renders directly as PDF + legacy EPS renders metadata)
    const aiPdfPath = path.join(tmpRoot, 'logo.ai');
    fs.writeFileSync(aiPdfPath, '%PDF-1.6\n<x:xmpmeta xmp:CreatorTool="Adobe Illustrator 29.0" xmpTPg:NPages="2"></x:xmpmeta>\n%%EOF');
    const aiPdfRes = renderDocument(aiPdfPath);
    assert.equal(aiPdfRes.ok, true);
    assert.equal(aiPdfRes.format, 'pdf');
    assert.equal(aiPdfRes.badge, 'AI');
    assert.ok(aiPdfRes.pdfBase64.length > 20);

    const aiEpsPath = path.join(tmpRoot, 'legacy.ai');
    fs.writeFileSync(aiEpsPath, '%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator(R) 10\n%%BoundingBox: 0 0 800 600\n%%DocumentProcessColors: Cyan Magenta Yellow Black\n');
    const aiEpsRes = renderDocument(aiEpsPath);
    assert.equal(aiEpsRes.ok, true);
    assert.equal(aiEpsRes.format, 'adobe');
    assert.ok(aiEpsRes.bodyHtml.includes('0 0 800 600'));

    // 5. MOGRT (ZIP with definition.json + thumb.png)
    const mogrtPath = path.join(tmpRoot, 'lower_third.mogrt');
    const defJson = JSON.stringify({
      capsuleName: '科技感字幕条',
      authorApp: 'After Effects 25.0',
      capsuleWidth: 1920,
      capsuleHeight: 1080,
      clientControls: [{ uiName: { strDB: [{ str: '主标题文本' }] }, type: 'text', value: { strDB: [{ str: 'AnchorWheel' }] } }],
      usedFonts: ['NotoSansCJKsc-Bold'],
    });
    const fakePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8b8AAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(mogrtPath, makeMinimalZip([{ name: 'definition.json', data: defJson }, { name: 'thumb.png', data: fakePng }]));
    const mogrtRes = renderDocument(mogrtPath);
    assert.equal(mogrtRes.ok, true);
    assert.equal(mogrtRes.badge, 'MOGRT');
    assert.ok(mogrtRes.previewThumbDataUrl.startsWith('data:image/png;base64,'));
    assert.ok(mogrtRes.bodyHtml.includes('科技感字幕条'));
    assert.ok(mogrtRes.bodyHtml.includes('主标题文本'));

    // 6. PRTEXTSTYLE
    const stylePath = path.join(tmpRoot, 'caption.prtextstyle');
    const fontB64 = Buffer.from('...SourceHanSansCN-Bold...', 'latin1').toString('base64');
    fs.writeFileSync(
      stylePath,
      `<PremiereData Version="3"><Project Version="42"/><FrameSize>0,0,1920,1080</FrameSize><StyleProjectItem><Name>中文影视字幕</Name></StyleProjectItem><StartKeyframeValue Encoding="base64">${fontB64}</StartKeyframeValue></PremiereData>`
    );
    const styleRes = renderDocument(stylePath);
    assert.equal(styleRes.ok, true);
    assert.ok(styleRes.bodyHtml.includes('中文影视字幕'));
    assert.ok(styleRes.bodyHtml.includes('SourceHanSansCN-Bold'));

    // 7. SESX
    const sesxPath = path.join(tmpRoot, 'mix.sesx');
    fs.writeFileSync(
      sesxPath,
      `<sesx version="1.9"><session sampleRate="48000" bitDepth="24" duration="480000"><tracks><audioTrack><trackParameters><title>人声主轨</title></trackParameters></audioTrack></tracks><files><file absolutePath="/Users/demo/vo.wav"/></files></session></sesx>`
    );
    const sesxRes = renderDocument(sesxPath);
    assert.equal(sesxRes.ok, true);
    assert.ok(sesxRes.bodyHtml.includes('48000 Hz'));
    assert.ok(sesxRes.bodyHtml.includes('人声主轨'));
    assert.ok(sesxRes.bodyHtml.includes('vo.wav'));

    // 8. INDD (with full 16-byte InDesign GUID magic)
    const inddPath = path.join(tmpRoot, 'book.indd');
    const inddMagic = Buffer.from([
      0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d,
    ]);
    const inddXmp = `<x:xmpmeta xmp:CreatorTool="Adobe InDesign 20.0" xmpTPg:NPages="24"><xmpGImg:image>${'A'.repeat(100)}</xmpGImg:image><stFnt:fontName>PingFangSC-Regular</stFnt:fontName></x:xmpmeta>`;
    fs.writeFileSync(inddPath, Buffer.concat([inddMagic, Buffer.from(inddXmp, 'utf8')]));
    const inddRes = renderDocument(inddPath);
    assert.equal(inddRes.ok, true);
    assert.ok(inddRes.bodyHtml.includes('24 页'));
    assert.ok(inddRes.previewThumbDataUrl.startsWith('data:image/jpeg;base64,'));

    // 9. CUBE 3D LUT (2x2x2 warm tint cube)
    const cubePath = path.join(tmpRoot, 'warm_film.cube');
    const cubeLines = [
      'TITLE "Warm Film Look"',
      'LUT_3D_SIZE 2',
      'DOMAIN_MIN 0.0 0.0 0.0',
      'DOMAIN_MAX 1.0 1.0 1.0',
      '0.05 0.02 0.00',
      '1.00 0.05 0.00',
      '0.05 0.95 0.02',
      '1.00 0.96 0.04',
      '0.04 0.04 0.90',
      '0.98 0.08 0.90',
      '0.05 0.92 0.90',
      '1.00 0.98 0.92',
    ];
    fs.writeFileSync(cubePath, cubeLines.join('\n'));
    const cubeRes = renderDocument(cubePath);
    assert.equal(cubeRes.ok, true);
    assert.equal(cubeRes.badge, 'CUBE');
    assert.ok(cubeRes.bodyHtml.includes('Warm Film Look'));
    assert.ok(cubeRes.bodyHtml.includes('aw-lut-grid'));

    // 10. External open dryRun allows all Adobe extensions safely
    for (const p of [psdPath, aepPath, prPath, aiPdfPath, mogrtPath, stylePath, sesxPath, inddPath, cubePath]) {
      const openRes = openExternalDocument(p, { dryRun: true });
      assert.equal(openRes.ok, true, `openExternalDocument should allow ${path.basename(p)}`);
    }

    // 11. P0-4 regression: PRPROJ with self-closing <Sequence ObjectURef="..."/> + top-level <VideoTrackGroup>
    const realStylePrXml = `<?xml version="1.0" encoding="UTF-8"?><PremiereData Version="3">
      <Project ObjectID="1" Version="43"/>
      <VideoTrackGroup ObjectUID="vtg-101"><FrameRect>0,0,3840,2160</FrameRect><FrameRate>4233600000</FrameRate></VideoTrackGroup>
      <BinProjectItem><Sequence ObjectURef="seq-202"/></BinProjectItem>
      <Sequence ObjectUID="seq-202"><TrackGroups><TrackGroup><Second ObjectURef="vtg-101"/></TrackGroup></TrackGroups><Name>4K60_母版序列</Name></Sequence>
    </PremiereData>`;
    const prRefPath = path.join(tmpRoot, 'ref_vtg.prproj');
    fs.writeFileSync(prRefPath, zlib.gzipSync(Buffer.from(realStylePrXml, 'utf8')));
    const prRefRes = renderDocument(prRefPath);
    assert.equal(prRefRes.ok, true);
    assert.ok(prRefRes.bodyHtml.includes('4K60_母版序列'));
    assert.ok(prRefRes.bodyHtml.includes('3840×2160'));
    assert.ok(prRefRes.bodyHtml.includes('60 fps'));

    // 12. P1-6 regression: Real Adobe MOGRT v1.7 Schema (sourceInfoLocalized, usedFontsLocalized, aefx, numeric control types, object uiName)
    const mogrtV17Path = path.join(tmpRoot, 'commercial_v17.mogrt');
    const v17Def = JSON.stringify({
      capsuleName: { strDB: [{ localeString: 'en_US', str: 'Kinetic Title v1.7' }] },
      authorApp: 'aefx',
      sourceInfoLocalized: {
        en_US: { framesize: [1920, 1080], framerate: 29.97, duration: 8.5, parentprojectfile: 'C:/Users/author/Temp/aegraphic/tmp.aep' },
      },
      usedFontsLocalized: { en_US: [{ fontName: 'Montserrat-Bold' }, 'SourceHanSansCN-Heavy'] },
      clientControls: [
        { uiName: { strDB: [] }, id: 'grp-01', type: 10, value: ['00000000-1111-2222-3333-444444444444', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'] },
        { uiName: { strDB: [{ str: '开启描边' }] }, type: 3, value: true },
      ],
    });
    fs.writeFileSync(mogrtV17Path, makeMinimalZip([{ name: 'definition.json', data: v17Def }]));
    const v17Res = renderDocument(mogrtV17Path);
    assert.equal(v17Res.ok, true);
    assert.equal(v17Res.bodyHtml.includes('[object Object]'), false);
    assert.equal(v17Res.bodyHtml.includes('aegraphic/tmp.aep'), false);
    assert.ok(v17Res.bodyHtml.includes('After Effects'));
    assert.ok(v17Res.bodyHtml.includes('1920 × 1080'));
    assert.ok(v17Res.bodyHtml.includes('29.97 fps'));
    assert.ok(v17Res.bodyHtml.includes('Montserrat-Bold'));
    assert.ok(v17Res.bodyHtml.includes('参数组'));
    assert.ok(v17Res.bodyHtml.includes('含 2 个子控件'));
    assert.ok(v17Res.bodyHtml.includes('复选框'));

    // 13. P1-7 regression: 0-byte & corrupt garbage rejection across Adobe formats
    for (const ext of ['.psd', '.aep', '.aepx', '.prproj', '.ai', '.mogrt', '.prtextstyle', '.sesx', '.indd', '.cube']) {
      const zeroPath = path.join(tmpRoot, `zero${ext}`);
      fs.writeFileSync(zeroPath, Buffer.alloc(0));
      assert.equal(renderDocument(zeroPath).ok, false, `0-byte ${ext} must fail cleanly`);

      const junkPath = path.join(tmpRoot, `junk${ext}`);
      fs.writeFileSync(junkPath, Buffer.from('RANDOM_CORRUPT_DATA_NOT_A_VALID_FILE_HEADER_1234567890', 'utf8'));
      assert.equal(renderDocument(junkPath).ok, false, `corrupt ${ext} must fail cleanly`);
    }

    // 14. P1-7 regression: 16-bit PSD layers stored inside Global Additional Layer Info (8BIMLr16)
    const psd16Path = path.join(tmpRoot, 'deep16.psd');
    const hdr16 = Buffer.alloc(26);
    hdr16.write('8BPS', 0, 'latin1');
    hdr16.writeUInt16BE(1, 4);
    hdr16.writeUInt16BE(4, 12);
    hdr16.writeUInt32BE(720, 14);
    hdr16.writeUInt32BE(1280, 18);
    hdr16.writeUInt16BE(16, 22);
    hdr16.writeUInt16BE(3, 24);
    const uni16 = '十六位渲染层';
    const uniBuf16 = Buffer.alloc(4 + uni16.length * 2);
    uniBuf16.writeUInt32BE(uni16.length, 0);
    for (let i = 0; i < uni16.length; i++) uniBuf16.writeUInt16BE(uni16.charCodeAt(i), 4 + i * 2);
    const luni16 = Buffer.concat([Buffer.from('8BIMluni', 'latin1'), u32be(uniBuf16.length), uniBuf16]);
    const extra16 = Buffer.concat([Buffer.alloc(8), Buffer.alloc(4), luni16]);
    const rec16 = Buffer.alloc(34);
    rec16.writeInt32BE(720, 8); rec16.writeInt32BE(1280, 12);
    rec16.write('8BIMnorm', 18, 'latin1'); rec16[26] = 255; rec16.writeUInt32BE(extra16.length, 30);
    const lr16Payload = Buffer.concat([i16be(1), rec16, extra16]);
    const lr16Block = Buffer.concat([Buffer.from('8BIMLr16', 'latin1'), u32be(lr16Payload.length), lr16Payload, lr16Payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    // layerInfoLen = 0 (4B), globalMaskLen = 0 (4B), followed by Lr16 block
    const lyrSec16 = Buffer.concat([u32be(0), u32be(0), lr16Block]);
    fs.writeFileSync(psd16Path, Buffer.concat([hdr16, u32be(0), u32be(0), u32be(lyrSec16.length), lyrSec16]));
    const psd16Res = renderDocument(psd16Path);
    assert.equal(psd16Res.ok, true);
    assert.ok(psd16Res.bodyHtml.includes('十六位渲染层'));
    assert.ok(psd16Res.bodyHtml.includes('16-bit'));
  } finally {
    prevSvc.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
  }
});
