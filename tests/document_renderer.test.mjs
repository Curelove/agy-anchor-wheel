import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  clearDocumentCache,
  getSupportedDocumentMeta,
  openExternalDocument,
  parseDelimitedRows,
  parseRtfToTextAndHtml,
  renderDocument,
} from '../sidecars/anchor_wheel/backend/document_renderer.mjs';
import { parseTarListingLine } from '../sidecars/anchor_wheel/backend/extra_formats_renderer.mjs';
import {
  detectLocalPresentationEngine,
  renderSlidesWithLocalEngine,
} from '../sidecars/anchor_wheel/backend/local_office_exporter.mjs';
import { readZipArchive } from '../sidecars/anchor_wheel/backend/zip_xml.mjs';

/**
 * Minimal pure-JS ZIP writer (CRC32 + Store/Deflate) for deterministic test fixture creation.
 */
const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const item of entries) {
    const nameBuf = Buffer.from(item.name, 'utf8');
    const rawBuf = Buffer.isBuffer(item.data) ? item.data : Buffer.from(String(item.data || ''), 'utf8');
    const useDeflate = item.deflate !== false && rawBuf.length > 0;
    const compBuf = useDeflate ? zlib.deflateRawSync(rawBuf) : rawBuf;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(rawBuf);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compBuf.length, 18);
    lh.writeUInt32LE(rawBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localParts.push(lh, nameBuf, compBuf);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compBuf.length, 20);
    cd.writeUInt32LE(rawBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    cdParts.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + compBuf.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}

// 1x1 PNG pixel fixture
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8b8AAAAASUVORK5CYII=',
  'base64'
);

test('zip_xml safely reads deflated UTF-8 archives and blocks traversal & decompression bombs', () => {
  const safeZip = buildZipBuffer([
    { name: '目录/测试.txt', data: '你好 AnchorWheel', deflate: true },
    { name: '../evil.txt', data: 'should be skipped', deflate: false },
    { name: 'big.txt', data: 'A'.repeat(200000), deflate: true },
  ]);
  const arc = readZipArchive(safeZip, { maxEntryBytes: 64 * 1024 });
  assert.equal(arc.getEntryText('目录/测试.txt'), '你好 AnchorWheel');
  assert.equal(arc.hasEntry('../evil.txt'), false);
  assert.throws(() => arc.getEntryBuffer('big.txt'), /size cap/i);
});

test('DOCX renderer parses headings, Chinese numbering, merged tables, embedded images, math, notes, links, and escapes XSS', () => {
  clearDocumentCache();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-docx-test-'));
  try {
    const docxPath = path.join(tmpDir, '研究报告样本.docx');
    const zipBuf = buildZipBuffer([
      {
        name: 'docProps/core.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>新媒体调查研究报告</dc:title><dc:creator>测试作者</dc:creator></cp:coreProperties>`,
      },
      {
        name: 'word/styles.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
          <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
            <w:style w:type="paragraph" w:styleId="SubHeading"><w:name w:val="SubHeading"/><w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
          </w:styles>`,
      },
      {
        name: 'word/numbering.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
          <w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:abstractNum w:abstractNumId="1">
              <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="%1、"/></w:lvl>
              <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="(%2)"/></w:lvl>
            </w:abstractNum>
            <w:num w:numId="5"><w:abstractNumId w:val="1"/></w:num>
          </w:numbering>`,
      },
      {
        name: 'word/_rels/document.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8"?>
          <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/>
            <Relationship Id="rLinkOk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report" TargetMode="External"/>
            <Relationship Id="rLinkBad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
          </Relationships>`,
      },
      {
        name: 'word/footnotes.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
          <w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:footnote w:id="1"><w:p><w:r><w:t>数据来源：2026年抽样调研。</w:t></w:r></w:p></w:footnote>
          </w:footnotes>`,
      },
      {
        name: 'word/comments.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
          <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:comment w:id="1" w:author="审稿老师" w:date="2026-11-26T10:00:00Z"><w:p><w:r><w:t>这里建议补充样本量说明。</w:t></w:r></w:p></w:comment>
          </w:comments>`,
      },
      { name: 'word/media/chart.png', data: TINY_PNG, deflate: false },
      {
        name: 'word/document.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
          <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
            <w:body>
              <w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:t>核心调研结论</w:t></w:r></w:p>
              <w:p><w:pPr><w:pStyle w:val="SubHeading"/></w:pPr><w:r><w:t>方法与公式</w:t></w:r></w:p>
              <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>第一项指标</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
              <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>子项内容 &lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>
              <w:p>
                <w:r><w:rPr><w:b/><w:color w:val="000000"/><w:highlight w:val="yellow"/></w:rPr><w:t>重点正文</w:t></w:r>
                <w:del><w:r><w:t>已删除草稿</w:t></w:r></w:del>
                <w:ins><w:r><w:t>修订新增</w:t></w:r></w:ins>
                <w:hyperlink r:id="rLinkOk"><w:r><w:t>外部参考</w:t></w:r></w:hyperlink>
                <w:hyperlink r:id="rLinkBad"><w:r><w:t>危险链接</w:t></w:r></w:hyperlink>
                <m:oMath><m:f><m:num><m:r><m:t>x</m:t></m:r></m:num><m:den><m:r><m:t>n</m:t></m:r></m:den></m:f></m:oMath>
              </w:p>
              <w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr name="Chart 1"/><a:graphic><a:graphicData><a:blip r:embed="rImg1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
              <w:tbl>
                <w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
                <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并表头</w:t></w:r></w:p></w:tc></w:tr>
                <w:tr>
                  <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>跨行类目</w:t></w:r></w:p></w:tc>
                  <w:tc><w:p><w:r><w:t>数值 A</w:t></w:r></w:p></w:tc>
                </w:tr>
                <w:tr>
                  <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
                  <w:tc><w:p><w:r><w:t>数值 B</w:t></w:r></w:p></w:tc>
                </w:tr>
              </w:tbl>
            </w:body>
          </w:document>`,
      },
    ]);
    fs.writeFileSync(docxPath, zipBuf);

    const res = renderDocument(docxPath);
    assert.equal(res.ok, true);
    assert.equal(res.format, 'docx');
    assert.equal(res.title, '新媒体调查研究报告');
    assert.equal(res.supportsPaperMode, true);
    assert.equal(res.outline.length, 2);
    assert.equal(res.outline[0].level, 1);
    assert.equal(res.outline[1].level, 2);
    assert.ok(res.bodyHtml.includes('一、'));
    assert.ok(res.bodyHtml.includes('(1)'));
    assert.ok(res.bodyHtml.includes('data-aw-ink="dark"'));
    assert.ok(res.bodyHtml.includes('修订新增'));
    assert.equal(res.bodyHtml.includes('已删除草稿'), false);
    assert.ok(res.bodyHtml.includes('href="https://example.com/report"'));
    assert.equal(res.bodyHtml.includes('javascript:alert'), false);
    assert.equal(res.bodyHtml.includes('<script>alert(1)</script>'), false);
    assert.ok(res.bodyHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(res.bodyHtml.includes('(x)/(n)'));
    assert.ok(res.bodyHtml.includes('data:image/png;base64,'));
    assert.ok(res.bodyHtml.includes('colspan="2"'));
    assert.ok(res.bodyHtml.includes('rowspan="2"'));
    assert.ok(res.bodyHtml.includes('数据来源：2026年抽样调研'));
    assert.ok(res.bodyHtml.includes('审稿老师'));

    const snip = renderDocument(docxPath, { snippetOnly: true });
    assert.equal(snip.ok, true);
    assert.ok(snip.snippetLines.some((l) => l.includes('核心调研结论')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('XLSX, PPTX, ODT, RTF, EPUB, CSV(GBK), legacy DOC, ZIP, and PDF renderers all work cleanly', () => {
  clearDocumentCache();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-docs-multi-'));
  try {
    // 1. XLSX with sharedStrings, date style, merged cells, and 2 sheets
    const xlsxPath = path.join(tmpDir, 'book.xlsx');
    fs.writeFileSync(
      xlsxPath,
      buildZipBuffer([
        {
          name: 'xl/workbook.xml',
          data: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="总览" sheetId="1" r:id="rId1"/><sheet name="明细" sheetId="2" r:id="rId2"/></sheets></workbook>`,
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
        },
        {
          name: 'xl/sharedStrings.xml',
          data: `<sst><si><t>书名</t></si><si><t>传播学导论</t></si></sst>`,
        },
        {
          name: 'xl/styles.xml',
          data: `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
        },
        {
          name: 'xl/worksheets/sheet1.xml',
          data: `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>日期</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>46352</v></c></row></sheetData><mergeCells><mergeCell ref="A3:B3"/></mergeCells></worksheet>`,
        },
        {
          name: 'xl/worksheets/sheet2.xml',
          data: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第二表数据</t></is></c></row></sheetData></worksheet>`,
        },
      ])
    );
    const xRes = renderDocument(xlsxPath);
    assert.equal(xRes.ok, true);
    assert.equal(xRes.format, 'xlsx');
    assert.equal(xRes.sections.length, 2);
    assert.ok(xRes.sections[0].html.includes('传播学导论'));
    assert.ok(xRes.sections[0].html.includes('2026-11-26'));
    assert.ok(xRes.sections[1].html.includes('第二表数据'));

    // 2. PPTX with slide order, image, and speaker notes
    const pptxPath = path.join(tmpDir, 'deck.pptx');
    fs.writeFileSync(
      pptxPath,
      buildZipBuffer([
        {
          name: 'ppt/presentation.xml',
          data: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
        },
        {
          name: 'ppt/_rels/presentation.xml.rels',
          data: `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`,
        },
        {
          name: 'ppt/slides/_rels/slide1.xml.rels',
          data: `<Relationships><Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/pic.png"/><Relationship Id="rNote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
        },
        { name: 'ppt/media/pic.png', data: TINY_PNG, deflate: false },
        {
          name: 'ppt/slides/slide1.xml',
          data: `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>开题汇报首页</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="rImg"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
        },
        {
          name: 'ppt/notesSlides/notesSlide1.xml',
          data: `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>此处讲30秒引入背景</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
        },
      ])
    );
    const pRes = renderDocument(pptxPath);
    assert.equal(pRes.ok, true);
    assert.equal(pRes.format, 'pptx');
    assert.equal(pRes.outline.length, 1);
    assert.ok(pRes.bodyHtml.includes('开题汇报首页'));
    assert.ok(pRes.bodyHtml.includes('data:image/png;base64,'));
    assert.ok(pRes.bodyHtml.includes('此处讲30秒引入背景'));

    // 3. ODT
    const odtPath = path.join(tmpDir, 'note.odt');
    fs.writeFileSync(
      odtPath,
      buildZipBuffer([
        {
          name: 'content.xml',
          data: `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">开放文档标题</text:h><text:p>正文段落内容</text:p></office:text></office:body></office:document-content>`,
        },
      ])
    );
    const oRes = renderDocument(odtPath);
    assert.equal(oRes.ok, true);
    assert.equal(oRes.format, 'odt');
    assert.ok(oRes.bodyHtml.includes('开放文档标题'));

    // 4. RTF with GBK hex Chinese + Unicode escape
    const rtfPath = path.join(tmpDir, 'memo.rtf');
    fs.writeFileSync(
      rtfPath,
      '{\\rtf1\\ansi\\ansicpg936{\\fonttbl{\\f0 SimSun;}}{\\*\\generator Test;}\\b \\\'d6\\\'d0\\\'ce\\\'c4\\b0 \\u27979?\\par Second line}',
      'latin1'
    );
    const rRes = renderDocument(rtfPath);
    assert.equal(rRes.ok, true);
    assert.equal(rRes.format, 'rtf');
    assert.ok(rRes.plainText.includes('中文'));
    assert.ok(rRes.plainText.includes('测'));
    assert.ok(rRes.bodyHtml.includes('<strong>中文</strong>'));

    // 5. EPUB with XSS sanitization
    const epubPath = path.join(tmpDir, 'book.epub');
    fs.writeFileSync(
      epubPath,
      buildZipBuffer([
        {
          name: 'META-INF/container.xml',
          data: `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
        },
        {
          name: 'OEBPS/content.opf',
          data: `<package><metadata><dc:title>电子书样本</dc:title><dc:creator>作者甲</dc:creator></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
        },
        {
          name: 'OEBPS/ch1.xhtml',
          data: `<html><body><h1>第一章</h1><p>阅读正文</p><script>evil()</script></body></html>`,
        },
      ])
    );
    const eRes = renderDocument(epubPath);
    assert.equal(eRes.ok, true);
    assert.equal(eRes.format, 'epub');
    assert.equal(eRes.title, '电子书样本');
    assert.ok(eRes.sections[0].html.includes('第一章'));
    assert.equal(eRes.sections[0].html.includes('<script'), false);

    // 6. GBK CSV with quoted commas
    const csvPath = path.join(tmpDir, 'data_gbk.csv');
    fs.writeFileSync(
      csvPath,
      Buffer.concat([
        Buffer.from([0xd0, 0xd5, 0xc3, 0xfb]), // 姓名
        Buffer.from(',"Score, Total"\nAlice,98\n', 'ascii'),
      ])
    );
    const cRes = renderDocument(csvPath);
    assert.equal(cRes.ok, true);
    assert.equal(cRes.format, 'csv');
    assert.equal(cRes.autoRender, false);
    assert.ok(cRes.bodyHtml.includes('姓名'));
    assert.ok(cRes.bodyHtml.includes('Score, Total'));

    // 7. Disguised RTF inside .doc + binary OLE2 .doc
    const fakeDocRtf = path.join(tmpDir, 'disguised.doc');
    fs.writeFileSync(fakeDocRtf, '{\\rtf1\\ansi\\ansicpg936 \\\'d6\\\'d0\\\'ce\\\'c4}', 'latin1');
    const fdRes = renderDocument(fakeDocRtf);
    assert.equal(fdRes.ok, true);
    assert.ok(fdRes.plainText.includes('中文'));
    assert.ok(fdRes.warnings.some((w) => w.includes('RTF')));

    const oleDoc = path.join(tmpDir, 'legacy.doc');
    fs.writeFileSync(
      oleDoc,
      Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]),
        Buffer.from('这是一段旧版文档的测试正文内容', 'utf16le'),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
      ])
    );
    const oleRes = renderDocument(oleDoc);
    assert.equal(oleRes.ok, true);
    assert.equal(oleRes.format, 'doc');
    assert.ok(oleRes.plainText.includes('旧版文档'));
    assert.ok(oleRes.warnings.length > 0);

    // 8. ZIP inventory & PDF meta
    const zipFile = path.join(tmpDir, 'pack.zip');
    fs.writeFileSync(zipFile, buildZipBuffer([{ name: 'readme.txt', data: 'hello world' }]));
    const zRes = renderDocument(zipFile);
    assert.equal(zRes.ok, true);
    assert.equal(zRes.format, 'zip');
    assert.ok(zRes.bodyHtml.includes('readme.txt'));

    const pdfFile = path.join(tmpDir, 'sample.pdf');
    fs.writeFileSync(pdfFile, '%PDF-1.4\n1 0 obj << /Type /Pages /Count 5 >> endobj\n<< /Title (Demo PDF) >>', 'latin1');
    const pdfRes = renderDocument(pdfFile);
    assert.equal(pdfRes.ok, true);
    assert.equal(pdfRes.format, 'pdf');
    assert.equal(pdfRes.meta.pageCount, 5);
    assert.equal(pdfRes.title, 'Demo PDF');

    // 9. Security guard on openExternalDocument
    const okExt = openExternalDocument(xlsxPath, { dryRun: true });
    assert.equal(okExt.ok, true);
    const badExe = path.join(tmpDir, 'danger.exe');
    fs.writeFileSync(badExe, 'MZ', 'ascii');
    assert.equal(openExternalDocument(badExe, { dryRun: true }).ok, false);
    assert.equal(openExternalDocument('\\\\evil-host\\share\\a.docx', { dryRun: true }).ok, false);

    assert.equal(getSupportedDocumentMeta('report.docx')?.autoRender, true);
    assert.equal(getSupportedDocumentMeta('table.csv')?.autoRender, false);
    assert.equal(parseDelimitedRows('a,b\n"c,d",e').rows[1][0], 'c,d');
    assert.ok(parseRtfToTextAndHtml('{\\rtf1 Hello\\par World}').plainLines.length === 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function buildTarEntry(fileName, contentStr) {
  const data = Buffer.from(contentStr, 'utf8');
  const hdr = Buffer.alloc(512, 0);
  hdr.write(fileName, 0, Math.min(100, Buffer.byteLength(fileName)), 'utf8');
  hdr.write('0000644\0', 100, 8, 'ascii');
  hdr.write('0000000\0', 108, 8, 'ascii');
  hdr.write('0000000\0', 116, 8, 'ascii');
  hdr.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  hdr.write('14720000000\0', 136, 12, 'ascii');
  hdr.fill(0x20, 148, 156);
  hdr[156] = '0'.charCodeAt(0);
  hdr.write('ustar\0', 257, 6, 'ascii');
  hdr.write('00', 263, 2, 'ascii');
  let chksum = 0;
  for (let i = 0; i < 512; i++) chksum += hdr[i];
  hdr.write(chksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padLen = (512 - (data.length % 512)) % 512;
  return Buffer.concat([hdr, data, Buffer.alloc(padLen, 0)]);
}

test('PPTX 2D visual renderer resolves theme/master/layout coordinates, group transforms, SVG shapes, charts, SmartArt, and deduplicates AlternateContent', async () => {
  clearDocumentCache();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pptx-vis-'));
  try {
    const pptxPath = path.join(tmpDir, 'visual_showcase.pptx');
    fs.writeFileSync(
      pptxPath,
      buildZipBuffer([
        {
          name: 'ppt/presentation.xml',
          data: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rSlide1"/></p:sldIdLst></p:presentation>`,
        },
        {
          name: 'ppt/_rels/presentation.xml.rels',
          data: `<Relationships><Relationship Id="rSlide1" Target="slides/slide1.xml"/></Relationships>`,
        },
        {
          name: 'ppt/theme/theme1.xml',
          data: `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:srgbClr val="1E293B"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="F59E0B"/></a:accent2></a:clrScheme></a:themeElements></a:theme>`,
        },
        {
          name: 'ppt/slideMasters/slideMaster1.xml',
          data: `<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt1" tx2="dk1" accent1="accent1" accent2="accent2"/><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"/></a:lvl1pPr></p:titleStyle></p:txStyles></p:sldMaster>`,
        },
        {
          name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
          data: `<Relationships><Relationship Id="rTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
        },
        {
          name: 'ppt/slideLayouts/slideLayout1.xml',
          data: `<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="457200"/><a:ext cx="10972800" cy="914400"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`,
        },
        {
          name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
          data: `<Relationships><Relationship Id="rMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
        },
        {
          name: 'ppt/charts/chart1.xml',
          data: `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>季度增长趋势</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>活跃度</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>42</c:v></c:pt><c:pt idx="1"><c:v>78</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
        },
        {
          name: 'ppt/diagrams/drawing1.xml',
          data: `<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dsp:spTree><dsp:sp><dsp:spPr><a:xfrm><a:off x="7000000" y="2200000"/><a:ext cx="4200000" cy="900000"/></a:xfrm><a:prstGeom prst="roundRect"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="20000"/><a:lumOff val="80000"/></a:schemeClr></a:solidFill></dsp:spPr><dsp:txBody><a:p><a:r><a:t>SmartArt 架构节点</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>`,
        },
        {
          name: 'ppt/slides/_rels/slide1.xml.rels',
          data: `<Relationships>
            <Relationship Id="rLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
            <Relationship Id="rChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
            <Relationship Id="rDgmDraw1" Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing" Target="../diagrams/drawing1.xml"/>
          </Relationships>`,
        },
        {
          name: 'ppt/slides/slide1.xml',
          data: `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
            <p:cSld><p:spTree>
              <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>真实空间版式总览</a:t></a:r></a:p></p:txBody></p:sp>
              <p:grpSp>
                <p:grpSpPr><a:xfrm><a:off x="609600" y="1600000"/><a:ext cx="5000000" cy="1200000"/><a:chOff x="0" y="0"/><a:chExt cx="5000000" cy="1200000"/></a:xfrm></p:grpSpPr>
                <p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2400000" cy="900000"/></a:xfrm><a:prstGeom prst="rightArrow"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:txBody><a:p><a:r><a:t>流程推进</a:t></a:r></a:p></p:txBody></p:sp>
              </p:grpSp>
              <mc:AlternateContent>
                <mc:Choice Requires="v"><p:sp><p:spPr><a:xfrm><a:off x="609600" y="3000000"/><a:ext cx="3000000" cy="600000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>唯一现代图形文本</a:t></a:r></a:p></p:txBody></p:sp></mc:Choice>
                <mc:Fallback><p:sp><p:spPr><a:xfrm><a:off x="609600" y="3000000"/><a:ext cx="3000000" cy="600000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>旧版回退重复文本</a:t></a:r></a:p></p:txBody></p:sp></mc:Fallback>
              </mc:AlternateContent>
              <p:graphicFrame><p:xfrm><a:off x="609600" y="3800000"/><a:ext cx="5400000" cy="2500000"/></p:xfrm><a:graphic><a:graphicData><c:chart r:id="rChart1"/></a:graphicData></a:graphic></p:graphicFrame>
              <p:graphicFrame><p:xfrm><a:off x="7000000" y="2200000"/><a:ext cx="4200000" cy="1800000"/></p:xfrm><a:graphic><a:graphicData><dgm:relIds r:dm="rDm1"/></a:graphicData></a:graphic></p:graphicFrame>
            </p:spTree></p:cSld>
          </p:sld>`,
        },
      ])
    );

    const res = renderDocument(pptxPath);
    assert.equal(res.ok, true);
    assert.equal(res.format, 'pptx');
    assert.equal(res.supportsLocalHiRes, true);
    assert.ok(res.bodyHtml.includes('class="aw-slide-stage"'));
    assert.ok(res.bodyHtml.includes('aspect-ratio:12192000 / 6858000'));
    assert.ok(res.bodyHtml.includes('background:#F8FAFC'));
    assert.ok(res.bodyHtml.includes('left:5.000%;top:6.667%')); // Inherited from slideLayout1!
    assert.ok(res.bodyHtml.includes('aw-ppt-geom-svg')); // rightArrow SVG
    assert.ok(res.bodyHtml.includes('aw-ppt-chart-svg')); // Native SVG chart
    assert.ok(res.bodyHtml.includes('季度增长趋势'));
    assert.ok(res.bodyHtml.includes('SmartArt 架构节点'));
    assert.ok(res.bodyHtml.includes('唯一现代图形文本'));
    assert.equal(res.bodyHtml.includes('旧版回退重复文本'), false);

    // Local presentation exporter dryRun + security validation
    const engineCheck = detectLocalPresentationEngine();
    assert.equal(typeof engineCheck.available, 'boolean');
    const dryRes = await renderSlidesWithLocalEngine(pptxPath, { dryRun: true, dataDir: tmpDir });
    if (engineCheck.available) {
      assert.equal(dryRes.ok, true);
      assert.equal(dryRes.dryRun, true);
    }
    const badTarget = path.join(tmpDir, 'evil.exe');
    fs.writeFileSync(badTarget, 'MZ', 'ascii');
    const blocked = await renderSlidesWithLocalEngine(badTarget, { dryRun: true, dataDir: tmpDir });
    assert.equal(blocked.ok, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DOCX AlternateContent deduplication + themeColor, XLSX phonetic exclusion + percent, and v0.9.0 expanded formats (.ipynb, .sqlite, .xls, .ppt, .tar.gz, .obj/.stl/.glb, .ttf, .srt/.ass, .jsonl, .eml, .pdf)', async () => {
  clearDocumentCache();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-v090-formats-'));
  try {
    // 1. DOCX with mc:AlternateContent textbox (no duplicate extraction) + w:themeColor
    const docxPath = path.join(tmpDir, 'textbox_dedup.docx');
    fs.writeFileSync(
      docxPath,
      buildZipBuffer([
        {
          name: 'word/theme/theme1.xml',
          data: `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme><a:accent1><a:srgbClr val="1D4ED8"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`,
        },
        {
          name: 'word/document.xml',
          data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml">
            <w:body>
              <w:p>
                <w:r><w:rPr><w:color w:themeColor="accent1"/></w:rPr><w:t>主题蓝标题</w:t></w:r>
                <mc:AlternateContent>
                  <mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>文本框正文只出现一次</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice>
                  <mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>文本框正文只出现一次</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>
                </mc:AlternateContent>
              </w:p>
            </w:body>
          </w:document>`,
        },
      ])
    );
    const dxRes = renderDocument(docxPath);
    assert.equal(dxRes.ok, true);
    assert.ok(dxRes.bodyHtml.includes('#1D4ED8'));
    const occurrences = dxRes.bodyHtml.split('文本框正文只出现一次').length - 1;
    assert.equal(occurrences, 1);

    // 2. XLSX <rPh> furigana phonetic exclusion + percentage format
    const xlsxPath = path.join(tmpDir, 'furigana_pct.xlsx');
    fs.writeFileSync(
      xlsxPath,
      buildZipBuffer([
        { name: 'xl/workbook.xml', data: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>` },
        { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
        { name: 'xl/sharedStrings.xml', data: `<sst><si><t>日本語</t><rPh sb="0" eb="3"><t>ニホンゴ</t></rPh></si></sst>` },
        { name: 'xl/styles.xml', data: `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="10"/></cellXfs></styleSheet>` },
        { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>0.642</v></c></row></sheetData></worksheet>` },
      ])
    );
    const xlRes = renderDocument(xlsxPath);
    assert.equal(xlRes.ok, true);
    assert.ok(xlRes.sections[0].html.includes('日本語'));
    assert.equal(xlRes.sections[0].html.includes('ニホンゴ'), false);
    assert.ok(xlRes.sections[0].html.includes('64.2%'));

    // 3. Disguised HTML .xls & SpreadsheetML 2003 .xls
    const htmlXlsPath = path.join(tmpDir, 'export_table.xls');
    fs.writeFileSync(htmlXlsPath, '<html><body><table><tr><th>科目</th><th>得分</th></tr><tr><td>传播学</td><td>95</td></tr></table></body></html>', 'utf8');
    const hxRes = renderDocument(htmlXlsPath);
    assert.equal(hxRes.ok, true);
    assert.equal(hxRes.format, 'xlsx');
    assert.ok(hxRes.sections[0].html.includes('传播学'));

    const xmlXlsPath = path.join(tmpDir, 'xml2003.xls');
    fs.writeFileSync(
      xmlXlsPath,
      `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="统计表"><Table><Row><Cell><Data ss:Type="String">样本数</Data></Cell><Cell><Data ss:Type="Number">512</Data></Cell></Row></Table></Worksheet></Workbook>`,
      'utf8'
    );
    const xxRes = renderDocument(xmlXlsPath);
    assert.equal(xxRes.ok, true);
    assert.equal(xxRes.sections[0].title, '统计表');
    assert.ok(xxRes.sections[0].html.includes('512'));

    // 4. Jupyter Notebook (.ipynb)
    const ipynbPath = path.join(tmpDir, 'analysis.ipynb');
    fs.writeFileSync(
      ipynbPath,
      JSON.stringify({
        metadata: { kernelspec: { display_name: 'Python 3.12' } },
        cells: [
          { cell_type: 'markdown', source: ['# 实验结果概览\n', '验证模型收敛曲线。'] },
          {
            cell_type: 'code',
            execution_count: 1,
            source: ['print("loss=0.024")\n'],
            outputs: [
              { output_type: 'stream', name: 'stdout', text: ['\u001b[32mloss=0.024\u001b[0m\n'] },
              { output_type: 'display_data', data: { 'image/png': TINY_PNG.toString('base64') } },
            ],
          },
        ],
      }),
      'utf8'
    );
    const nbRes = renderDocument(ipynbPath);
    assert.equal(nbRes.ok, true);
    assert.equal(nbRes.format, 'ipynb');
    assert.equal(nbRes.preferWhenRawCode, true);
    assert.equal(nbRes.outline.length, 1);
    assert.ok(nbRes.bodyHtml.includes('loss=0.024'));
    assert.equal(nbRes.bodyHtml.includes('\u001b[32m'), false);
    assert.ok(nbRes.bodyHtml.includes('data:image/png;base64,'));

    // P0-1 regression: .ipynb image/png XSS payload must be strictly rejected
    const xssNbPath = path.join(tmpDir, 'xss_probe.ipynb');
    fs.writeFileSync(
      xssNbPath,
      JSON.stringify({
        nbformat: 4,
        cells: [
          {
            cell_type: 'code',
            execution_count: 1,
            source: ['print(1)'],
            outputs: [
              {
                output_type: 'display_data',
                data: {
                  'image/png': 'x"onerror="window.__agAnchorWheelCall()"data-x="',
                },
              },
            ],
          },
        ],
      }),
      'utf8'
    );
    const xssNbRes = renderDocument(xssNbPath);
    assert.equal(xssNbRes.ok, true);
    assert.equal(xssNbRes.bodyHtml.includes('onerror'), false);
    assert.equal(xssNbRes.bodyHtml.includes('__agAnchorWheelCall'), false);

    // P1-5 regression: parseTarListingLine handles both Linux GNU tar and BSD tar formats
    const gnuEntry = parseTarListingLine('-rw-r--r-- root/root 1248 2026-11-27 02:15 docs/README.md');
    assert.deepEqual(gnuEntry, { name: 'docs/README.md', isDirectory: false, size: 1248 });
    const bsdEntry = parseTarListingLine('-rw-r--r--  0 user group 2048 Nov 27 02:15 assets/logo.svg');
    assert.deepEqual(bsdEntry, { name: 'assets/logo.svg', isDirectory: false, size: 2048 });

    // 5. SQLite 3 Database (.sqlite)
    let sqliteMod = null;
    try {
      sqliteMod = await import('node:sqlite');
    } catch {}
    if (sqliteMod?.DatabaseSync) {
      const { DatabaseSync } = sqliteMod;
      const sqlitePath = path.join(tmpDir, 'metrics.sqlite');
      const db = new DatabaseSync(sqlitePath);
      db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, score REAL); INSERT INTO users VALUES (1, '林夏', 98.5);`);
      db.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY, event TEXT); INSERT INTO logs VALUES (1, 'boot_ok');`);
      db.close();

      const sqRes = renderDocument(sqlitePath);
      assert.equal(sqRes.ok, true);
      assert.equal(sqRes.format, 'sqlite');
      assert.equal(sqRes.sections.length, 2);
      assert.ok(sqRes.sections.some((s) => s.html.includes('林夏') && s.html.includes('98.5')));
    }

    // 6. POSIX .tar.gz archive
    const tarGzPath = path.join(tmpDir, 'bundle.tar.gz');
    const tarRaw = Buffer.concat([
      buildTarEntry('pkg/index.mjs', 'export default 42;\n'),
      buildTarEntry('pkg/README.md', '# Hello\n'),
      Buffer.alloc(1024, 0),
    ]);
    fs.writeFileSync(tarGzPath, zlib.gzipSync(tarRaw));
    const tgRes = renderDocument(tarGzPath);
    assert.equal(tgRes.ok, true);
    assert.equal(tgRes.format, 'zip');
    assert.equal(tgRes.badge, 'TAR.GZ');
    assert.ok(tgRes.bodyHtml.includes('pkg/index.mjs'));

    // 7. 3D Models (.obj, binary .stl, binary .glb)
    const objPath = path.join(tmpDir, 'pyramid.obj');
    fs.writeFileSync(
      objPath,
      'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 2 4\n',
      'utf8'
    );
    const objRes = renderDocument(objPath);
    assert.equal(objRes.ok, true);
    assert.equal(objRes.format, 'model3d');
    assert.equal(objRes.meshData.triangleCount, 2);

    const stlPath = path.join(tmpDir, 'tri.stl');
    const stlBuf = Buffer.alloc(84 + 50, 0);
    stlBuf.writeUInt32LE(1, 80);
    stlBuf.writeFloatLE(1.0, 84 + 24); // v1.x = 1
    stlBuf.writeFloatLE(1.0, 84 + 40); // v2.y = 1
    fs.writeFileSync(stlPath, stlBuf);
    const stlRes = renderDocument(stlPath);
    assert.equal(stlRes.ok, true);
    assert.equal(stlRes.meshData.triangleCount, 1);

    const glbPath = path.join(tmpDir, 'tri.glb');
    const binFloats = Buffer.alloc(36, 0);
    binFloats.writeFloatLE(1.0, 12); // v1.x
    binFloats.writeFloatLE(1.0, 28); // v2.y
    const gltfJsonStr = JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    });
    const jsonPadded = Buffer.from(gltfJsonStr.padEnd(Math.ceil(Buffer.byteLength(gltfJsonStr) / 4) * 4, ' '), 'utf8');
    const glbHeader = Buffer.alloc(12);
    glbHeader.writeUInt32LE(0x46546c67, 0);
    glbHeader.writeUInt32LE(2, 4);
    glbHeader.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binFloats.length, 8);
    const jHdr = Buffer.alloc(8);
    jHdr.writeUInt32LE(jsonPadded.length, 0);
    jHdr.writeUInt32LE(0x4e4f534a, 4);
    const bHdr = Buffer.alloc(8);
    bHdr.writeUInt32LE(binFloats.length, 0);
    bHdr.writeUInt32LE(0x004e4942, 4);
    fs.writeFileSync(glbPath, Buffer.concat([glbHeader, jHdr, jsonPadded, bHdr, binFloats]));
    const glbRes = renderDocument(glbPath);
    assert.equal(glbRes.ok, true);
    assert.equal(glbRes.meshData.triangleCount, 1);

    // 8. Font (.ttf), Subtitles (.ass & .srt), JSONL (.jsonl), Email (.eml), and PDF base64
    const ttfPath = path.join(tmpDir, 'demo.ttf');
    const ttfBuf = Buffer.alloc(64, 0);
    ttfBuf.writeUInt32BE(0x00010000, 0);
    fs.writeFileSync(ttfPath, ttfBuf);
    const fontRes = renderDocument(ttfPath);
    assert.equal(fontRes.ok, true);
    assert.equal(fontRes.format, 'font');
    assert.ok(fontRes.fontData.dataUrl.startsWith('data:font/ttf;base64,'));

    const assPath = path.join(tmpDir, 'episode01.ass');
    fs.writeFileSync(
      assPath,
      '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:03.80,Default,,0,0,0,,{\\pos(960,1010)}第一句台词\\N第二行\n',
      'utf8'
    );
    const assRes = renderDocument(assPath);
    assert.equal(assRes.ok, true);
    assert.equal(assRes.optionalTable, true);
    assert.ok(assRes.bodyHtml.includes('第一句台词'));
    assert.equal(assRes.bodyHtml.includes('\\pos'), false);

    const jsonlPath = path.join(tmpDir, 'events.jsonl');
    fs.writeFileSync(jsonlPath, '{"step":1,"model":"Carbon","ok":true}\n{"step":2,"model":"Neon","ok":true}\n', 'utf8');
    const jlRes = renderDocument(jsonlPath);
    assert.equal(jlRes.ok, true);
    assert.ok(jlRes.bodyHtml.includes('Carbon'));

    const emlPath = path.join(tmpDir, 'notice.eml');
    const subjB64 = Buffer.from('课程开题答辩通知', 'utf8').toString('base64');
    fs.writeFileSync(
      emlPath,
      `From: =?UTF-8?B?${Buffer.from('教务处', 'utf8').toString('base64')}?= <office@example.edu>\r\nTo: student@example.edu\r\nSubject: =?UTF-8?B?${subjB64}?=\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('请于周五下午两点准时参加答辩。', 'utf8').toString('base64')}\r\n`,
      'ascii'
    );
    const emlRes = renderDocument(emlPath);
    assert.equal(emlRes.ok, true);
    assert.equal(emlRes.format, 'eml');
    assert.ok(emlRes.bodyHtml.includes('课程开题答辩通知'));
    assert.ok(emlRes.bodyHtml.includes('请于周五下午两点准时参加答辩'));

    const pdfPath = path.join(tmpDir, 'embed.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >> endobj\n', 'latin1');
    const pdfRes = renderDocument(pdfPath);
    assert.equal(pdfRes.ok, true);
    assert.ok(pdfRes.pdfBase64.length > 10);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
