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
