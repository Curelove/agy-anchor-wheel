import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer } from '../sidecars/anchor_wheel/main.mjs';

const AUDIT_CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

function makeAuditZip(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;
  for (const item of entries) {
    const nameBuf = Buffer.from(item.name, 'utf8');
    const rawBuf = Buffer.isBuffer(item.data) ? item.data : Buffer.from(String(item.data || ''), 'utf8');
    const compBuf = rawBuf.length ? zlib.deflateRawSync(rawBuf) : rawBuf;
    const method = rawBuf.length ? 8 : 0;
    let crc = 0xffffffff;
    for (let i = 0; i < rawBuf.length; i++) crc = AUDIT_CRC_TABLE[(crc ^ rawBuf[i]) & 0xff] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compBuf.length, 18);
    lh.writeUInt32LE(rawBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
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

function findBrowserExe() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('No headless Chromium browser (Chrome/Edge) found');
}

async function waitForPortFile(userDataDir, timeoutMs = 8000) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(portFile)) {
      const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for headless browser DevToolsActivePort');
}

class AuditCdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params?.exceptionDetails?.text || 'Uncaught exception');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        this.errors.push(msg.params.args?.map((a) => a.value || a.description).join(' ') || 'console.error');
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalAsync(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    return res?.result?.value;
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 480,
    });
    await new Promise((r) => setTimeout(r, 180));
  }

  async screenshot(outPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
  }
}

async function runAudit() {
  const outDir = process.argv[2] || path.join(os.tmpdir(), 'aw-audit-shots');
  fs.mkdirSync(outDir, { recursive: true });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-vis-'));
  const wsDir = path.join(tmpDirOr(tmpRoot), 'ws');
  const brainDir = path.join(tmpRoot, 'brain');
  const convBrain = path.join(brainDir, 'conv-demo-01');
  const dataDir = path.join(tmpRoot, 'data');
  const profileDir = path.join(tmpRoot, 'chrome-profile');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(convBrain, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  // Create realistic test workspace & artifacts
  const pyFile = path.join(wsDir, 'render_pipeline.py');
  fs.writeFileSync(
    pyFile,
    'import math\n\ndef render_frame(idx: int, fps: int = 60):\n    t = idx / fps\n    return math.sin(t * 2.0)\n',
    'utf8'
  );
  const archMd = path.join(wsDir, 'architecture_notes.md');
  fs.writeFileSync(archMd, '# 渲染管线架构说明\n\n详见核心模块 `render_pipeline.py`。\n', 'utf8');
  const notesMd = path.join(wsDir, 'audio_sync.md');
  fs.writeFileSync(notesMd, '# 声画同步规则\n\n对齐节拍头与嘴型偏移校验。\n', 'utf8');
  const gbkFile = path.join(wsDir, 'legacy_log_gbk.txt');
  fs.writeFileSync(
    gbkFile,
    Buffer.concat([
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xb1, 0xa8, 0xb8, 0xe6]), // 中文测试报告
      Buffer.from(': ', 'ascii'),
      Buffer.from([0xd5, 0xfd, 0xb3, 0xa3, 0xbd, 0xe2, 0xc2, 0xeb, 0xce, 0xde, 0xc2, 0xd2, 0xc2, 0xeb]), // 正常解码无乱码
      Buffer.from('\nLine 2: ASCII fallback check.\n', 'ascii'),
    ])
  );
  const svgFile = path.join(wsDir, 'preview_card.svg');
  fs.writeFileSync(
    svgFile,
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" rx="16" fill="#182032"/><circle cx="160" cy="80" r="44" fill="#669df6" fill-opacity="0.3" stroke="#669df6" stroke-width="3"/></svg>',
    'utf8'
  );
  const extraPngs = [1, 2, 3, 4, 5].map((n) => {
    const p = path.join(wsDir, `frame_0${n}.svg`);
    fs.writeFileSync(p, `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#234"/></svg>`, 'utf8');
    return p;
  });

  // Rich Office fixtures (DOCX, XLSX, PPTX) for visual audit
  const sampleDocx = path.join(wsDir, '调查问卷与阶段报告样本.docx');
  fs.writeFileSync(
    sampleDocx,
    makeAuditZip([
      {
        name: 'docProps/core.xml',
        data: `<cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>短视频用户碎片化观看行为调查报告</dc:title><dc:creator>研究小组</dc:creator></cp:coreProperties>`,
      },
      {
        name: 'word/styles.xml',
        data: `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style></w:styles>`,
      },
      {
        name: 'word/numbering.xml',
        data: `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="%1、"/></w:lvl></w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
      },
      {
        name: 'word/footnotes.xml',
        data: `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>有效问卷回收率 92.4%，覆盖 18-29 岁青年群体。</w:t></w:r></w:p></w:footnote></w:footnotes>`,
      },
      {
        name: 'word/document.xml',
        data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:t>短视频用户碎片化观看行为调查报告</w:t></w:r></w:p>
          <w:p><w:pPr><w:ind w:firstLineChars="200"/></w:pPr><w:r><w:rPr><w:color w:val="000000"/></w:rPr><w:t>本报告聚焦青年群体在日常通勤与睡前场景中的碎片化观看习惯，重点分析倍速播放、跳转进度条与完播率变化。</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
          <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>一、核心样本分布</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>高频场景：</w:t></w:r><w:r><w:t>通勤途中与睡前 30 分钟占比合计达到 68.5%。</w:t></w:r></w:p>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:rPr><w:b/><w:color w:val="C00000"/></w:rPr><w:t>关键发现：</w:t></w:r><w:r><w:t>超过六成受访者在观看 3 分钟以上内容时会开启 1.5x 倍速。</w:t></w:r></w:p>
          <w:tbl>
            <w:tblGrid><w:gridCol w:w="2600"/><w:gridCol w:w="2200"/><w:gridCol w:w="2200"/></w:tblGrid>
            <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:shd w:fill="E8EEF5"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>维度</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:shd w:fill="E8EEF5"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>B站样本</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:shd w:fill="E8EEF5"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>抖音样本</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>日均观看时长</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>74 分钟</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>89 分钟</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>常用倍速比例</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>64.2%</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>41.8%</w:t></w:r></w:p></w:tc></w:tr>
          </w:tbl>
          <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>二、后续跟进建议</w:t></w:r></w:p>
          <w:p><w:r><w:t>建议结合深度访谈对「信息过载疲劳」现象作进一步质性补充。</w:t></w:r></w:p>
        </w:body></w:document>`,
      },
    ])
  );

  const sampleXlsx = path.join(wsDir, '阅读书单汇总.xlsx');
  fs.writeFileSync(
    sampleXlsx,
    makeAuditZip([
      {
        name: 'xl/workbook.xml',
        data: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="传播学书单" sheetId="1" r:id="rId1"/><sheet name="方法论参考" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
      },
      {
        name: 'xl/sharedStrings.xml',
        data: `<sst><si><t>书名</t></si><si><t>作者</t></si><si><t>推荐年级</t></si><si><t>理解媒介</t></si><si><t>麦克卢汉</t></si><si><t>大二</t></si><si><t>传播学教程</t></si><si><t>郭庆光</t></si><si><t>大一</t></si></sst>`,
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row><row r="3"><c r="A3" t="s"><v>6</v></c><c r="B3" t="s"><v>7</v></c><c r="C3" t="s"><v>8</v></c></row></sheetData></worksheet>`,
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        data: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>研究方法书目</t></is></c></row></sheetData></worksheet>`,
      },
    ])
  );

  const samplePptx = path.join(wsDir, '课堂汇报演示.pptx');
  fs.writeFileSync(
    samplePptx,
    makeAuditZip([
      {
        name: 'ppt/presentation.xml',
        data: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
      },
      {
        name: 'ppt/_rels/presentation.xml.rels',
        data: `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>`,
      },
      {
        name: 'ppt/theme/theme1.xml',
        data: `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Studio"><a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="0D9488"/></a:accent2><a:accent3><a:srgbClr val="F59E0B"/></a:accent3></a:clrScheme></a:themeElements></a:theme>`,
      },
      {
        name: 'ppt/charts/chart1.xml',
        data: `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>各端样本完播率对比 (%)</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>1.0x 原速</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>通勤场景</c:v></c:pt><c:pt idx="1"><c:v>午休场景</c:v></c:pt><c:pt idx="2"><c:v>睡前场景</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>48</c:v></c:pt><c:pt idx="1"><c:v>63</c:v></c:pt><c:pt idx="2"><c:v>81</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>1.5x 倍速</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>通勤场景</c:v></c:pt><c:pt idx="1"><c:v>午休场景</c:v></c:pt><c:pt idx="2"><c:v>睡前场景</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>76</c:v></c:pt><c:pt idx="1"><c:v>79</c:v></c:pt><c:pt idx="2"><c:v>72</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
      },
      {
        name: 'ppt/slides/_rels/slide1.xml.rels',
        data: `<Relationships><Relationship Id="rNote1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/><Relationship Id="rChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`,
      },
      {
        name: 'ppt/slides/slide1.xml',
        data: `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld>
          <p:bg><p:bgPr><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill></p:bgPr></p:bg>
          <p:spTree>
            <p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="220000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>
            <p:sp><p:spPr><a:xfrm><a:off x="720000" y="480000"/><a:ext cx="10600000" cy="860000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="2800" b="1"><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill></a:rPr><a:t>新媒体调查方法 · 阶段汇报</a:t></a:r></a:p></p:txBody></p:sp>
            <p:sp><p:spPr><a:xfrm><a:off x="720000" y="1280000"/><a:ext cx="9200000" cy="520000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="1400"><a:solidFill><a:srgbClr val="475569"/></a:solidFill></a:rPr><a:t>短视频平台青年用户碎片化观看机制与倍速行为研究</a:t></a:r></a:p></p:txBody></p:sp>
            <p:sp><p:spPr><a:xfrm><a:off x="720000" y="2100000"/><a:ext cx="4300000" cy="1850000"/></a:xfrm><a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="EFF6FF"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="BFDBFE"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr lIns="180000" tIns="140000"/><a:p><a:r><a:rPr sz="1500" b="1"><a:solidFill><a:srgbClr val="1D4ED8"/></a:solidFill></a:rPr><a:t>样本回收 92.4%</a:t></a:r></a:p><a:p><a:r><a:rPr sz="1200"><a:solidFill><a:srgbClr val="334155"/></a:solidFill></a:rPr><a:t>有效样本 N = 648，覆盖双城高校在读群体</a:t></a:r></a:p></p:txBody></p:sp>
            <p:sp><p:spPr><a:xfrm><a:off x="720000" y="4250000"/><a:ext cx="4300000" cy="1850000"/></a:xfrm><a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="F0FDFA"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="99F6E4"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr lIns="180000" tIns="140000"/><a:p><a:r><a:rPr sz="1500" b="1"><a:solidFill><a:srgbClr val="0F766E"/></a:solidFill></a:rPr><a:t>倍速常态化 64.2%</a:t></a:r></a:p><a:p><a:r><a:rPr sz="1200"><a:solidFill><a:srgbClr val="334155"/></a:solidFill></a:rPr><a:t>3 分钟以上中长内容普遍启用 1.5x 观看</a:t></a:r></a:p></p:txBody></p:sp>
            <p:graphicFrame><p:xfrm><a:off x="5450000" y="2100000"/><a:ext cx="6050000" cy="4000000"/></p:xfrm><a:graphic><a:graphicData><c:chart r:id="rChart1"/></a:graphicData></a:graphic></p:graphicFrame>
          </p:spTree></p:cSld></p:sld>`,
      },
      {
        name: 'ppt/slides/slide2.xml',
        data: `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld>
          <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>
          <p:spTree>
            <p:sp><p:spPr><a:xfrm><a:off x="720000" y="520000"/><a:ext cx="10600000" cy="800000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="2400" b="1"><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill></a:rPr><a:t>研究推进链路</a:t></a:r></a:p></p:txBody></p:sp>
            <p:sp><p:spPr><a:xfrm><a:off x="720000" y="2300000"/><a:ext cx="3100000" cy="1400000"/></a:xfrm><a:prstGeom prst="chevron"/><a:solidFill><a:srgbClr val="1E40AF"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1500" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>1. 问卷预调研</a:t></a:r></a:p></p:txBody></p:sp>
            <p:sp><p:spPr><a:xfrm><a:off x="4300000" y="2300000"/><a:ext cx="3100000" cy="1400000"/></a:xfrm><a:prstGeom prst="chevron"/><a:solidFill><a:srgbClr val="2563EB"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1500" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>2. 分层抽样回收</a:t></a:r></a:p></p:txBody></p:sp>
            <p:sp><p:spPr><a:xfrm><a:off x="7880000" y="2300000"/><a:ext cx="3100000" cy="1400000"/></a:xfrm><a:prstGeom prst="chevron"/><a:solidFill><a:srgbClr val="0D9488"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1500" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>3. 深度访谈交叉</a:t></a:r></a:p></p:txBody></p:sp>
          </p:spTree></p:cSld></p:sld>`,
      },
      {
        name: 'ppt/notesSlides/notesSlide1.xml',
        data: `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>开场 30 秒：简要介绍选题来源与样本覆盖范围。</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      },
    ])
  );

  // Interactive 3D Octahedron + Jupyter Notebook fixtures for v0.9.0 visual audit
  const sampleObj = path.join(wsDir, '几何白模样本.obj');
  fs.writeFileSync(
    sampleObj,
    [
      'v 0 1.25 0',
      'v 1 0 0',
      'v 0 0 1',
      'v -1 0 0',
      'v 0 0 -1',
      'v 0 -1.25 0',
      'f 1 3 2',
      'f 1 2 5',
      'f 1 5 4',
      'f 1 4 3',
      'f 6 2 3',
      'f 6 5 2',
      'f 6 4 5',
      'f 6 3 4',
    ].join('\n'),
    'utf8'
  );

  const sampleIpynb = path.join(wsDir, '数据回归分析.ipynb');
  fs.writeFileSync(
    sampleIpynb,
    JSON.stringify({
      metadata: { kernelspec: { display_name: 'Python 3.12' } },
      cells: [
        { cell_type: 'markdown', source: ['# 碎片化观看时长回归模型\n', '检验日均短视频打开频次与注意力的相关性。'] },
        {
          cell_type: 'code',
          execution_count: 4,
          source: ['import numpy as np\n', 'r2, p_val = 0.684, 0.0003\n', 'print(f"R² = {r2:.3f}, p = {p_val}")'],
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['R² = 0.684, p = 0.0003\n'] }],
        },
      ],
    }),
    'utf8'
  );

  const grandparentMd = path.join(convBrain, '00_总纲入口.md');
  const summaryMd = path.join(convBrain, 'V2_验收汇总报告.md');
  fs.writeFileSync(
    grandparentMd,
    `# 项目总纲\n\n- [V2 验收汇总报告](${summaryMd})\n- [architecture_notes.md](${archMd})\n`,
    'utf8'
  );
  fs.writeFileSync(
    summaryMd,
    [
      '# V2 音画同步交付验收总览',
      '',
      '本报告汇总了本次重构涉及的全部核心脚本、架构文档与分镜图：',
      '',
      '| 模块 | 关联文件 | 说明 |',
      '| :--- | :--- | :--- |',
      `| 核心管线 | [render_pipeline.py](${pyFile}) | 主帧率计算与曲线采样 |`,
      `| 架构设计 | [architecture_notes.md](${archMd}) | 模块职责拆分 |`,
      `| 声画规范 | [audio_sync.md](${notesMd}) | 节拍对齐检查 |`,
      `| 历史日志 | [legacy_log_gbk.txt](${gbkFile}) | GBK 编码日志样本 |`,
      `| 预览图0 | [preview_card.svg](${svgFile}) | 矢量预览样本 |`,
      ...extraPngs.map((ep, i) => `| 分镜${i + 1} | [frame_0${i + 1}.svg](${ep}) | 序列帧 ${i + 1} |`),
      `| 已删除项 | [ghost_missing.md](${path.join(wsDir, 'ghost_missing.md')}) | 测试失效链接标红 |`,
      '',
      '```python',
      'print("AnchorWheel optical code block")',
      '```',
    ].join('\n'),
    'utf8'
  );

  const inst = await startServer({
    standalone: true,
    noCdp: true,
    noUpdateCheck: true,
    port: 0,
    dataDir,
    workspaceRoots: [wsDir],
    brainDir,
  });

  let browserProc = null;
  let ws = null;

  try {
    const exe = findBrowserExe();
    browserProc = spawn(
      exe,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true }
    );

    const cdpPort = await waitForPortFile(profileDir);
    const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const page = pages.find((p) => p.type === 'page') || pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const cdp = new AuditCdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const baseUrl = `http://127.0.0.1:${inst.port}/`;
    await cdp.setViewport(1440, 940);
    await cdp.send('Page.navigate', { url: baseUrl });
    await new Promise((r) => setTimeout(r, 700));

    // 1. 1440px Dark Obsidian Home Desk + verify [hidden] subbar pills & encoding banner are truly hidden (0px height!)
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'obsidian')`);
    await new Promise((r) => setTimeout(r, 150));
    const hiddenCheckHome = await cdp.evalAsync(`(() => {
      const ids = ['aw-encoding-banner', 'aw-btn-tree', 'aw-btn-pin-anchor', 'aw-btn-links', 'aw-btn-reveal', 'aw-btn-encoding'];
      return ids.filter((id) => {
        const el = document.getElementById(id);
        return el && el.getBoundingClientRect().height > 0;
      });
    })()`);
    await cdp.screenshot(path.join(outDir, '01_1440_obsidian_home.png'));

    // Navigate grandparent -> summary so ancestor trunk has grandparent + parent!
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(grandparentMd)})`);
    await new Promise((r) => setTimeout(r, 250));
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(summaryMd)})`);
    await new Promise((r) => setTimeout(r, 350));

    // 2. 1440px Obsidian Bilateral Wheel (holdMode = true, zero bottom buttons, hover image arc + open rail)
    await cdp.evalAsync(`(() => {
      window.__awWorkbench.openBilateralWheel(560, 420, { holdMode: true, persistOnScroll: false });
    })()`);
    await new Promise((r) => setTimeout(r, 180));
    await cdp.evalAsync(`(() => {
      const arcs = document.querySelectorAll('.aw-bi-cat-arc:not([data-empty="1"])');
      arcs[0]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 180));
    await cdp.evalAsync(`(() => {
      const more = document.querySelector('.aw-bi-more-pill');
      more?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 200));
    await cdp.evalAsync(`(() => {
      const firstSub = document.querySelector('.aw-bi-rail-item');
      firstSub?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 420));
    await cdp.screenshot(path.join(outDir, '02_1440_obsidian_bilateral.png'));

    // 3. 1440px Warm AE Tree (Tab persistent) + 0.25s hover preview
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'warm')`);
    await cdp.evalAsync(`window.__awWorkbench.openAeTree({ fromTabMode: true })`);
    await new Promise((r) => setTimeout(r, 250));
    await cdp.evalAsync(`(() => {
      const firstChild = document.querySelector('.aw-tree-row[data-current="1"] .aw-tree-child');
      firstChild?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 420));
    await cdp.screenshot(path.join(outDir, '03_1440_warm_aetree_preview.png'));

    // 4. 1440px Obsidian Settings & Reactive Interactive Guide Modal (strict single-active tri-state)
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'obsidian')`);
    await cdp.evalAsync(`window.__awWorkbench.openSettingsModal('modes')`);
    await new Promise((r) => setTimeout(r, 320));
    await cdp.screenshot(path.join(outDir, '04_1440_obsidian_settings_modes.png'));

    // 4b. Verify reactive click-switch to ae_tree + right parentDirection mirror in live preview!
    await cdp.evalAsync(`(() => {
      const p = document.getElementById('aw-sm-pdir');
      if (p) { p.value = 'right'; p.dispatchEvent(new Event('change', { bubbles: true })); }
      document.querySelector('[data-aw-guide-card="ae_tree"]')?.click();
    })()`);
    await new Promise((r) => setTimeout(r, 320));
    await cdp.screenshot(path.join(outDir, '04b_1440_obsidian_settings_reactive.png'));

    // 4c. 1440px Obsidian Categories Tab with 7 custom categories + '其他' (8 total sectors, zero overlap!)
    await cdp.evalAsync(`(() => {
      document.querySelector('[data-aw-sm-tab="categories"]')?.click();
    })()`);
    await new Promise((r) => setTimeout(r, 120));
    await cdp.evalAsync(`(() => {
      const add = document.getElementById('aw-sm-add-rule');
      if (add) { add.click(); add.click(); add.click(); add.click(); }
      const body = document.querySelector('.aw-settings-body');
      if (body) body.scrollTop = 0;
    })()`);
    await new Promise((r) => setTimeout(r, 260));
    await cdp.screenshot(path.join(outDir, '04c_1440_obsidian_settings_7cats.png'));

    // 4d. 1440px Obsidian Settings Storage / Update & Compat Diagnostics (scroll down to reveal full compat + update card)
    await cdp.evalAsync(`(() => {
      document.querySelector('[data-aw-sm-tab="storage"]')?.click();
      setTimeout(() => {
        const box = document.getElementById('aw-sm-update-box');
        box?.scrollIntoView({ block: 'end' });
      }, 60);
    })()`);
    await new Promise((r) => setTimeout(r, 280));
    await cdp.screenshot(path.join(outDir, '08b_1440_obsidian_settings_compat.png'));

    // 4e. Close settings and inspect Backlinks / Outlinks Popover at 1440px
    await cdp.evalAsync(`(() => {
      document.getElementById('aw-sm-close')?.click();
      document.getElementById('aw-btn-links')?.click();
    })()`);
    await new Promise((r) => setTimeout(r, 220));
    await cdp.screenshot(path.join(outDir, '04d_1440_obsidian_links_popover.png'));

    // 5. 1100px Alabaster Light Theme AE Tree with stacked corner expanded
    await cdp.setViewport(1100, 860);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'alabaster')`);
    await cdp.evalAsync(`window.__awWorkbench.openAeTree({ fromTabMode: true })`);
    await new Promise((r) => setTimeout(r, 220));
    await cdp.evalAsync(`document.querySelector('.aw-tree-stack-corner')?.click()`);
    await new Promise((r) => setTimeout(r, 220));
    await cdp.screenshot(path.join(outDir, '05_1100_alabaster_aetree.png'));

    // 6. 390px Narrow side-pane Bilateral Wheel
    await cdp.setViewport(390, 844);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'obsidian')`);
    await cdp.evalAsync(`window.__awWorkbench.openBilateralWheel(195, 420, { holdMode: true })`);
    await new Promise((r) => setTimeout(r, 200));
    await cdp.evalAsync(`document.querySelectorAll('.aw-bi-cat-arc:not([data-empty="1"])')[0]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 250));
    const overflowBilateral = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '06_390_obsidian_bilateral.png'));

    // 7. 390px Crystal Light AE Tree
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'crystal')`);
    await cdp.evalAsync(`window.__awWorkbench.openAeTree({ fromTabMode: true })`);
    await new Promise((r) => setTimeout(r, 250));
    const overflowTree = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '07_390_crystal_aetree.png'));

    // 8. 390px Alabaster Settings Modal (categories + storage compat)
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'alabaster')`);
    await cdp.evalAsync(`window.__awWorkbench.openSettingsModal('categories')`);
    await new Promise((r) => setTimeout(r, 250));
    const overflowSettings = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '08_390_alabaster_settings.png'));

    await cdp.evalAsync(`document.querySelector('[data-aw-sm-tab="storage"]')?.click()`);
    await new Promise((r) => setTimeout(r, 250));
    await cdp.evalAsync(`
      const body = document.querySelector('.aw-settings-body');
      if (body) body.scrollTop = body.scrollHeight;
    `);
    await new Promise((r) => setTimeout(r, 150));
    const overflowSettingsCompat = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '09_390_alabaster_settings_compat.png'));

    // 9. Mode 2 Directory View (1440px Obsidian with Bilateral Wheel + 390px Crystal)
    await cdp.evalAsync(`document.getElementById('aw-sm-close')?.click()`);
    await cdp.setViewport(1440, 900);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'obsidian')`);
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(wsDir)}, { inNewTab: true, isDirectory: true })`);
    await new Promise((r) => setTimeout(r, 280));
    await cdp.evalAsync(`window.__awWorkbench.openBilateralWheel(560, 420, { holdMode: true, persistOnScroll: false })`);
    await new Promise((r) => setTimeout(r, 180));
    await cdp.evalAsync(`document.querySelectorAll('.aw-bi-cat-arc:not([data-empty="1"])')[0]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 220));
    await cdp.screenshot(path.join(outDir, '10_1440_obsidian_dir_wheel.png'));

    await cdp.setViewport(390, 844);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'crystal')`);
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(wsDir)}, { skipHistory: true, isDirectory: true })`);
    await new Promise((r) => setTimeout(r, 220));
    const overflowDirView = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '11_390_crystal_dir_view.png'));

    // 10. Rich Document Viewer Audit (DOCX Theme + Outline, DOCX Paper Mode, Narrow 390px DOCX, XLSX, PPTX)
    await cdp.setViewport(1440, 900);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'obsidian')`);
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(sampleDocx)}, { inNewTab: true })`);
    await new Promise((r) => setTimeout(r, 320));
    await cdp.evalAsync(`document.querySelector('[data-aw-doc-act="outline"]')?.click()`);
    await new Promise((r) => setTimeout(r, 140));
    await cdp.screenshot(path.join(outDir, '12_1440_obsidian_docx_outline.png'));

    await cdp.evalAsync(`document.querySelector('[data-aw-doc-act="paper"]')?.click()`);
    await new Promise((r) => setTimeout(r, 160));
    await cdp.screenshot(path.join(outDir, '13_1440_obsidian_docx_paper.png'));

    await cdp.setViewport(390, 844);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'crystal')`);
    await cdp.evalAsync(`document.querySelector('[data-aw-outline-close]')?.click(); document.querySelector('[data-aw-doc-act="paper"]')?.click();`);
    await new Promise((r) => setTimeout(r, 200));
    const overflowDocxNarrow = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '14_390_crystal_docx.png'));

    await cdp.setViewport(1100, 860);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'alabaster')`);
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(sampleXlsx)}, { inNewTab: true })`);
    await new Promise((r) => setTimeout(r, 260));
    const overflowXlsx = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '15_1100_alabaster_xlsx.png'));

    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'warm')`);
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(samplePptx)}, { inNewTab: true })`);
    await new Promise((r) => setTimeout(r, 260));
    await cdp.evalAsync(`document.querySelector('.aw-slide-notes')?.setAttribute('open', 'open')`);
    await new Promise((r) => setTimeout(r, 120));
    const overflowPptx = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '16_1100_warm_pptx.png'));

    await cdp.setViewport(390, 844);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'obsidian')`);
    await new Promise((r) => setTimeout(r, 200));
    const overflowPptxNarrow = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '17_390_obsidian_pptx_narrow.png'));

    await cdp.setViewport(1100, 860);
    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'obsidian')`);
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(sampleObj)}, { inNewTab: true })`);
    await new Promise((r) => setTimeout(r, 260));
    const overflow3d = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '18_1100_obsidian_3d_obj.png'));

    await cdp.evalAsync(`document.documentElement.setAttribute('data-aw-theme', 'alabaster')`);
    await cdp.evalAsync(`window.__awWorkbench.openFile(${JSON.stringify(sampleIpynb)}, { inNewTab: true })`);
    await new Promise((r) => setTimeout(r, 260));
    const overflowIpynb = await cdp.evalAsync(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    await cdp.screenshot(path.join(outDir, '19_1100_alabaster_ipynb.png'));

    console.log(JSON.stringify({
      ok: true,
      outDir,
      hiddenCheckHome,
      overflowBilateral,
      overflowTree,
      overflowSettings,
      overflowSettingsCompat,
      overflowDirView,
      overflowDocxNarrow,
      overflowXlsx,
      overflowPptx,
      overflowPptxNarrow,
      overflow3d,
      overflowIpynb,
      consoleErrors: cdp.errors,
    }, null, 2));
  } finally {
    try { ws?.close(); } catch {}
    if (browserProc) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1500);
        browserProc.once('exit', () => { clearTimeout(t); resolve(); });
        try { browserProc.kill(); } catch { resolve(); }
      });
    }
    await inst.stop();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    } catch {}
  }
}

function tmpDirOr(p) { return p; }

void runAudit().catch((e) => {
  console.error(e);
  process.exit(1);
});
