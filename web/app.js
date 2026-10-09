/* MoeGuard 喵图混淆 · 纯前端网页版：引擎复用 src/core.js，本文件只做载体与交互 */
'use strict';
(function () {
  const Core = window.__MoeGuardCore;
  const $ = (id) => document.getElementById(id);
  if (!Core) {
    $('empty').textContent = '引擎 src/core.js 没加载成功 —— 请从仓库根目录打开本页（GitHub Pages 要部署在根路径）。';
    return;
  }

  const REASON = {
    'not-moe': '不是喵图（找不到 MOE 标记）—— 想把它变成喵图请选「强制混淆」',
    'bad-salt': '盐值不符：这是喵图，但群组盐值和它不一样',
    'resized': '尺寸对不上：图被缩放或重编码过，像素已无法无损还原',
  };
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

  const items = [];
  let seq = 0;
  let running = false;
  let lastPngPath = '';
  let modalItem = null;
  let modalSide = 'after';
  let modalPeek = false;

  /* ---------- 小工具 ---------- */
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function baseName(name) {
    return String(name || 'image').replace(/\.[^.]+$/, '');
  }
  function samePixels(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ---------- 图片载体 ---------- */
  async function blobToImageData(blob) {
    const bmp = await createImageBitmap(blob);
    try {
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
      return { width: id.width, height: id.height, data: id.data };
    } finally {
      try { bmp.close(); } catch (e) {}
    }
  }
  function imageDataToCanvas(im) {
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const id = ctx.createImageData(im.width, im.height);
    id.data.set(im.data);
    ctx.putImageData(id, 0, 0);
    return c;
  }
  /* 三级回落：CompressionStream → canvas.toBlob → 无压缩 stored PNG */
  async function encodePng(im) {
    if (Core.encodePngFast) {
      try {
        const u8 = await Core.encodePngFast(im);
        lastPngPath = 'fast';
        return u8;
      } catch (e) {}
    }
    try {
      const c = imageDataToCanvas(im);
      const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('null-blob'))), 'image/png'));
      lastPngPath = 'canvas';
      return new Uint8Array(await blob.arrayBuffer());
    } catch (e) {}
    lastPngPath = 'store';
    return Core.encodePngStore(im);
  }

  /* ---------- 方向判定：只认权威信号，不用启发式，避免把普通照片误判成喵图 ---------- */
  function sniff(bytes, img, salt) {
    if (Core.isPng(bytes)) {
      const mk = Core.pngReadMarker(bytes, salt);
      if (mk) return { dir: 'dec', why: mk.saltOk ? '命中 moEg 标记块' : '命中 moEg 标记块（盐值不符）' };
    }
    if (Core.probeMagic(img.data, img.width, img.height)) return { dir: 'dec', why: '命中末行元数据像素' };
    return { dir: 'enc', why: '没有 MOE 标记' };
  }

  function readOpts() {
    const t = $('tile').value;
    return {
      salt: $('salt').value.trim(),
      tile: t ? parseInt(t, 10) : undefined,
      mode: $('mode').value,
      keepMeta: $('meta').checked,
    };
  }

  /* ---------- 处理一张 ---------- */
  async function processItem(it) {
    const opts = readOpts();
    const t0 = performance.now();
    const bytes = new Uint8Array(await it.file.arrayBuffer());
    const img = await blobToImageData(it.file);
    it.srcW = img.width; it.srcH = img.height;

    let dir = opts.mode, why = '强制' + (dir === 'enc' ? '混淆' : '解混淆');
    if (dir === 'auto') {
      const s = sniff(bytes, img, opts.salt);
      dir = s.dir; why = s.why;
    }
    const notes = [];

    if (dir === 'dec') {
      const dec = Core.decodeImage(img, { salt: opts.salt });
      if (!dec.ok) throw new Error(REASON[dec.reason] || ('解码失败：' + dec.reason));
      let chunks = null;
      if (opts.keepMeta) { try { chunks = Core.pngReadMetaChunks(bytes); } catch (e) {} }
      let u8 = await encodePng(dec);
      if (chunks && chunks.length) u8 = Core.pngRestoreTextChunks(u8, chunks);
      it.result = { blob: new Blob([u8], { type: 'image/png' }), w: dec.width, h: dec.height, kind: 'dec' };
      it.name = baseName(it.file.name) + '.decoded.png';
      if (chunks && chunks.length) notes.push('已还原 ' + chunks.length + ' 条 PNG 文本元数据');
    } else {
      const enc = Core.encodeImage(img, { tile: opts.tile, salt: opts.salt });
      let chunks = null;
      if (opts.keepMeta) { try { chunks = Core.pngGetTextChunks(bytes); } catch (e) {} }
      let u8 = await encodePng(enc);
      /* 顺序不能反：两个块都插在 IHDR 后，后插的在前，moEg 必须落在前 128 字节内 */
      if (chunks && chunks.length) u8 = Core.pngPutTextChunks(u8, chunks);
      u8 = Core.pngAddMarker(u8, enc.meta);
      it.result = { blob: new Blob([u8], { type: 'image/png' }), w: enc.width, h: enc.height, kind: 'enc' };
      it.name = baseName(it.file.name) + '.moe.png';
      notes.push('T=' + enc.meta.T);
      if (opts.salt) notes.push('盐值已启用');
      if (chunks && chunks.length) notes.push('已内嵌 ' + chunks.length + ' 条 PNG 文本元数据');
    }

    it.ms = performance.now() - t0;
    it.resultUrl = URL.createObjectURL(it.result.blob);
    it.note = why + ' → ' + (dir === 'dec' ? '解混淆' : '混淆') + (notes.length ? ' · ' + notes.join(' · ') : '');
  }

  /* ---------- 队列 ---------- */
  async function pump() {
    if (running) return;
    running = true;
    for (;;) {
      const it = items.find((x) => x.state === 'queued');
      if (!it) break;
      it.state = 'busy';
      render(it);
      try {
        await processItem(it);
        it.state = 'done';
      } catch (e) {
        it.state = 'error';
        it.error = String((e && e.message) || e);
      }
      render(it);
      updateToolbar();
    }
    running = false;
  }

  function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /^image\//.test(f.type || ''));
    if (!files.length) return;
    for (const f of files) {
      const it = {
        id: ++seq, file: f, state: 'queued', error: '', note: '',
        thumbUrl: URL.createObjectURL(f), result: null, resultUrl: '', name: f.name,
        srcW: 0, srcH: 0, ms: 0,
      };
      it.el = makeCard(it);
      items.push(it);
      $('list').appendChild(it.el.li);
      render(it);
    }
    updateToolbar();
    pump();
  }

  function makeCard(it) {
    const li = document.createElement('li');
    li.className = 'card item';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    img.alt = ''; img.src = it.thumbUrl;
    thumb.appendChild(img);
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = it.file.name;
    const status = document.createElement('div');
    status.className = 'status';
    const note = document.createElement('div');
    note.className = 'note';
    info.append(name, status, note);
    const acts = document.createElement('div');
    acts.className = 'acts';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.onclick = fn;
      return b;
    };
    const dl = mk('下载', () => it.state === 'done' && saveBlob(it.result.blob, it.name));
    const cmp = mk('查看', () => openModal(it));
    const rm = mk('移除', () => removeItem(it));
    acts.append(dl, cmp, rm);
    thumb.title = '查看大图';
    thumb.onclick = () => openModal(it);
    li.append(thumb, info, acts);
    it.el = { li, img, status, note, dl, cmp };
    return it.el;
  }

  function render(it) {
    const el = it.el;
    el.status.className = 'status';
    if (it.state === 'queued') el.status.textContent = '排队中…';
    else if (it.state === 'busy') el.status.textContent = '处理中…';
    else if (it.state === 'error') {
      el.status.className = 'status bad';
      el.status.textContent = '✗ ' + it.error;
    } else {
      el.status.className = 'status ok';
      el.status.textContent = '✓ ' + (it.result.kind === 'dec' ? '已还原原图' : '已混淆') +
        ' · ' + it.srcW + '×' + it.srcH + ' → ' + it.result.w + '×' + it.result.h +
        ' · ' + fmtSize(it.file.size) + ' → ' + fmtSize(it.result.blob.size) +
        ' · ' + Math.round(it.ms) + 'ms';
      el.img.src = it.resultUrl;
    }
    el.note.textContent = it.state === 'error' ? '' : (it.note || '');
    el.dl.disabled = it.state !== 'done';
    if (modalItem === it) paintModal();
  }

  function removeItem(it) {
    const i = items.indexOf(it);
    if (i < 0) return;
    items.splice(i, 1);
    URL.revokeObjectURL(it.thumbUrl);
    if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
    it.el.li.remove();
    if (modalItem === it) closeModal();
    updateToolbar();
  }

  function clearAll() {
    for (const it of items.slice()) removeItem(it);
  }

  function updateToolbar() {
    const done = items.filter((x) => x.state === 'done').length;
    $('zip').disabled = done === 0;
    $('clear').disabled = items.length === 0;
    $('empty').style.display = items.length ? 'none' : 'block';
    $('zip').textContent = done > 1 ? '全部下载 ZIP（' + done + '）' : '全部下载 ZIP';
  }

  /* ---------- 查看大图 ---------- */
  function openModal(it, side) {
    if (it.state !== 'done' && !it.thumbUrl) return;
    modalItem = it;
    modalPeek = it.state !== 'done';
    modalSide = it.state === 'done' ? (side || 'after') : 'before';
    paintModal();
    $('modal').hidden = false;
  }

  function paintModal() {
    const it = modalItem;
    if (!it) return;
    const done = it.state === 'done';
    const dec = done && it.result.kind === 'dec';
    /* 预览等待中的图时它跑完了 → 自动切到结果那一侧 */
    if (modalPeek && done) { modalPeek = false; modalSide = 'after'; }
    const before = {
      url: it.thumbUrl,
      label: dec ? '混淆图' : '原图',
      cap: '拖入的文件' + (it.srcW ? ' ' + it.srcW + '×' + it.srcH : '') + ' · ' + fmtSize(it.file.size),
    };
    const after = done ? {
      url: it.resultUrl,
      label: dec ? '还原图' : '混淆图',
      cap: (dec ? '还原的原图 ' : '混淆结果 ') + it.result.w + '×' + it.result.h + ' · ' + fmtSize(it.result.blob.size),
    } : null;

    $('mTitle').textContent = it.file.name + (done ? ' → ' + it.name : '（处理中）');
    $('mDl').disabled = !done;
    $('mSide').hidden = !after;
    const cur = (modalSide === 'before' || !after) ? before : after;
    $('mOne').src = cur.url;
    $('mOne').classList.remove('native');
    $('mOneCap').textContent = cur.cap;
    $('mSideBefore').textContent = before.label;
    $('mSideAfter').textContent = after ? after.label : '';
    $('mSideBefore').classList.toggle('on', cur === before);
    $('mSideAfter').classList.toggle('on', cur !== before);
    $('mInfo').textContent = it.note || '';
  }

  function closeModal() {
    modalItem = null;
    $('modal').hidden = true;
    $('mOne').removeAttribute('src');
  }

  /* ---------- 批量 ZIP（store 存储，PNG 已压缩过，再压没意义） ---------- */
  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = Core.crc32(f.u8);
      const lh = new Uint8Array(30 + name.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, DOS_TIME, true);
      lv.setUint16(12, DOS_DATE, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, f.u8.length, true);
      lv.setUint32(22, f.u8.length, true);
      lv.setUint16(26, name.length, true);
      lh.set(name, 30);
      parts.push(lh, f.u8);

      const ch = new Uint8Array(46 + name.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, DOS_TIME, true);
      cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, f.u8.length, true);
      cv.setUint32(24, f.u8.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, off, true);
      ch.set(name, 46);
      central.push(ch);
      off += lh.length + f.u8.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, off, true);
    return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
  }

  async function downloadZip() {
    const done = items.filter((x) => x.state === 'done');
    if (!done.length) return;
    const used = new Map();
    const files = [];
    for (const it of done) {
      const n = (used.get(it.name) || 0) + 1;
      used.set(it.name, n);
      const name = n > 1 ? it.name.replace(/\.png$/, '') + '-' + n + '.png' : it.name;
      files.push({ name, u8: new Uint8Array(await it.result.blob.arrayBuffer()) });
    }
    saveBlob(zipStore(files), 'moeguard-' + files.length + '张.zip');
  }

  /* ---------- 引擎自检：把本页整条链路（变换 + PNG 编码 + 解码）跑一遍 ---------- */
  async function selfTest() {
    const out = $('verdict');
    out.textContent = '自检中…';
    try {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 220;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const g = ctx.createLinearGradient(0, 0, 320, 220);
      g.addColorStop(0, '#ff9bd2'); g.addColorStop(1, '#7c6bf0');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 320, 220);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 24px "Microsoft YaHei", sans-serif';
      ctx.fillText('MoeGuard 喵图', 28, 88);
      ctx.font = '13px "Microsoft YaHei", sans-serif';
      ctx.fillText('混→解 应逐像素一致', 28, 120);
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = i % 2 ? '#fff' : '#2b2440';
        ctx.fillRect(20 + i * 24, 160, 24, 24);
      }
      const src = ctx.getImageData(0, 0, 320, 220);
      const im = { width: src.width, height: src.height, data: src.data };

      const t0 = performance.now();
      const enc = Core.encodeImage(im, {});
      const t1 = performance.now();
      const png = await encodePng(enc);
      const t2 = performance.now();
      const back = await blobToImageData(new Blob([png], { type: 'image/png' }));
      const t3 = performance.now();
      const dec = Core.decodeImage(back, {});
      const t4 = performance.now();

      const pngOk = back.width === enc.width && back.height === enc.height && samePixels(back.data, enc.data);
      const rtOk = dec.ok && samePixels(dec.data, im.data);
      const parts = [];
      parts.push(pngOk
        ? '<span class="ok">✓ PNG 编码无损</span>（路径 ' + lastPngPath + '）'
        : '<span class="bad">✗ PNG 编码后像素变了</span>');
      parts.push(rtOk
        ? '<span class="ok">✓ 混淆→解码 逐像素一致</span>'
        : '<span class="bad">✗ 往返不一致' + (dec.ok ? '' : '（' + (REASON[dec.reason] || dec.reason) + '）') + '</span>');
      parts.push('编码 ' + (t1 - t0).toFixed(0) + 'ms / PNG ' + (t2 - t1).toFixed(0) +
        'ms / 读回 ' + (t3 - t2).toFixed(0) + 'ms / 解码 ' + (t4 - t3).toFixed(0) + 'ms');
      out.innerHTML = parts.join(' · ');
    } catch (e) {
      out.innerHTML = '<span class="bad">✗ 自检出错：' + String((e && e.message) || e) + '</span>';
    }
  }

  /* ---------- 事件接线 ---------- */
  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); }
  });
  $('pick').addEventListener('click', (e) => { e.stopPropagation(); $('file').click(); });
  $('file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles(e.dataTransfer && e.dataTransfer.files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  document.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = dt.files && dt.files.length
      ? dt.files
      : Array.from(dt.items || []).filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  $('zip').addEventListener('click', downloadZip);
  $('clear').addEventListener('click', clearAll);
  $('selfTest').addEventListener('click', selfTest);
  $('mClose').addEventListener('click', closeModal);
  $('mSideBefore').addEventListener('click', () => { modalSide = 'before'; paintModal(); });
  $('mSideAfter').addEventListener('click', () => { modalSide = 'after'; paintModal(); });
  $('mOne').addEventListener('click', () => $('mOne').classList.toggle('native'));
  $('mDl').addEventListener('click', () => { if (modalItem && modalItem.result) saveBlob(modalItem.result.blob, modalItem.name); });
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalItem) closeModal(); });

  $('engine').textContent = '引擎 MOE v' + Core.VERSION + '（与浏览器扩展同一份 core.js）';
  updateToolbar();
})();
