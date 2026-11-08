// Offline main-process checks for ByteVC2 playback, prefetch and download:
// conversion orchestration, queue priorities, phases, cache identity and failure cleanup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const { load, roots } = require('./check-playback-cache.cjs');
const { CONVERSION_PRIORITIES } = require('../src/native/bytevc2');

const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);
const bytevc2PlayInfo = { source: 'app', codec: 'bytevc2', duration: 46.8, width: 1080, height: 1920,
  contentKey: '0123456789abcdef0123456789abcdef', url: 'https://fixture.invalid/bytevc2.mp4', quality: '1080p' };
const defer = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

// probeVideoInfo that classifies generated fixtures as playable H.264/AAC.
function installH264Probe(h, duration = bytevc2PlayInfo.duration) {
  h.context.probeVideoInfo = async (_probe, file) => {
    h.metrics.probes++;
    const data = fs.readFileSync(file);
    return data.length >= 4096 && data[0] === 1
      ? { codec: 'h264', w: data[1] === 7 ? 720 : 1080, h: data[1] === 7 ? 1280 : 1920, duration,
        video: { pix_fmt: 'yuv420p', codec_tag_string: 'avc1' }, audio: true, audioStream: { codec_name: 'aac' } }
      : null;
  };
}
function installConversionStub(h, log, gate, started) {
  h.context.resolveFfmpeg = name => name === 'librempeg' ? '/fixture/librempeg' : '/fixture/ffprobe';
  h.context.convertBytevc2ToH264 = async (input, output, playInfo, options = {}) => {
    const record = { input, output, playInfo, priorityAtStart: options.getPriority?.() };
    log.push(record);
    options.onPhase?.('queued');
    options.onPhase?.('transcoding');
    options.onProgress?.(Math.min(10, playInfo.duration), playInfo.duration);
    started?.resolve();
    if (gate) await gate.promise;
    record.priorityAfterGate = options.getPriority?.();
    if (options.signal?.aborted || options.cancelToken?.reason) throw Object.assign(new Error('已取消 ByteVC2 转码'), { code: 'ERR_CANCELED' });
    fs.writeFileSync(output, Buffer.alloc(4096, 1), { mode: 0o600 });
    return { codec: 'h264', size: 4096, encoder: 'libx264',
      verified: { codec: 'h264', width: playInfo.width, height: playInfo.height, actualQuality: Math.min(playInfo.width, playInfo.height) + 'p', directH264: true } };
  };
}

const window = (h, index, quality = 'auto', sid = 'S') => h.handlers['set-playback-window']({}, { seriesId: sid, vidIndex: index, quality,
  episodes: Array.from({ length: 30 }, (_, i) => i + 1).filter(i => Math.abs(i - index) <= 5).map(i => ({ vid: 'v' + i, vidIndex: i })) });
const prepare = (h, index, extra = {}) => h.handlers['prepare-online-play']({}, { disk: true, vid: 'v' + index, seriesId: 'S', vidIndex: index,
  requestId: 'r-' + Math.random(), quality: 'auto', ...extra });

// A small download-side harness (settings + task registry only) for executeHongguoDownload.
function downloadFixture({ playInfo = bytevc2PlayInfo } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-bytevc2-dl-'));
  roots.push(root);
  const handlers = {}, events = [], app = new EventEmitter();
  const conversions = [];
  Object.assign(app, { getPath: () => root, getVersion: () => 'test', commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  let settings = { root, download_quality: 'auto' }, saved;
  const context = vm.createContext({ require: n => n === 'electron'
    ? { app, ipcMain: { handle: (name2, fn) => handlers[name2] = fn }, protocol: { registerSchemesAsPrivileged() {} } }
    : n === './src/native/hongguo' ? { fetchPlayUrlSingle: async (vid, sid, options) => ({ ...playInfo, vid }),
      deriveKey: () => Buffer.alloc(16, 9) }
    : n === './src/store' ? { getSettings: () => settings, saveSettings: s => settings = s,
      saveTasks: tasks => { saved = JSON.parse(JSON.stringify(tasks)); } }
    : n === './src/native/bytevc2' ? { convertBytevc2: async () => { throw new Error('module path must go through convertBytevc2ToH264'); }, CONVERSION_PRIORITIES }
    : req(n),
    __dirname: path.dirname(source), process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  context.resolveFfmpeg = name => name === 'librempeg' ? '/fixture/librempeg' : '/fixture/ffprobe';
  context.probeVideoInfo = async (_probe, file) => { const data = fs.readFileSync(file);
    return data.length >= 4096 && data[0] === 1 ? { codec: 'h264', w: 1080, h: 1920, duration: playInfo.duration,
      video: { pix_fmt: 'yuv420p', codec_tag_string: 'avc1' }, audio: true, audioStream: { codec_name: 'aac' } } : null; };
  context.convertBytevc2ToH264 = async (input, output, info, options = {}) => {
    conversions.push({ input, output, priority: options.getPriority?.(), hadToken: !!options.cancelToken });
    options.onPhase?.('queued');
    options.onProgress?.(20, info.duration);
    fs.writeFileSync(output, Buffer.alloc(4096, 1), { mode: 0o600 });
    return { codec: 'h264', size: 4096, encoder: 'libx264',
      verified: { codec: 'h264', width: info.width, height: info.height, actualQuality: '1080p', directH264: true } };
  };
  context.requestMedia = async () => ({ headers: { 'content-length': '4096' }, data: Readable.from([Buffer.alloc(4096, 7)]) });
  context.sendToRenderer = (name2, payload) => events.push({ name: name2, ...payload });
  const run = text => vm.runInContext(text, context);
  run('pumpQueue = () => {}; seriesRegistry = [{ series_id: "1", series_title: "测试剧", episodes: [{ vid: "11", vid_index: 1 }] }];');
  return { root, context, run, handlers, events, conversions, saved: () => saved };
}

const checks = [
  ['managed playback converts ByteVC2 once, publishes H.264 identity and replays progress', async () => {
    const h = load(null, { playInfo: bytevc2PlayInfo }), conversions = [];
    installH264Probe(h); installConversionStub(h, conversions);
    assert.equal(window(h, 10).success, true);
    const first = await prepare(h, 10);
    assert.equal(first.success, true, first.error);
    assert.equal(first.codec, 'h264');
    assert.equal(first.width, 1080);
    assert.equal(first.directH264, true);
    assert.equal(first.mediaSource, 'app');
    assert.equal(conversions.length, 1, 'exactly one conversion per episode');
    const entry = h.run("onlineCache.get('disk:auto:v10')");
    assert.equal(entry.originalCodec, 'bytevc2');
    assert.equal(entry.conversion, 'libx264-v1');
    assert.equal(entry.codec, 'h264');
    const metadata = JSON.parse(fs.readFileSync(path.join(entry.disk.directory, 'metadata.json'), 'utf8'));
    assert.equal(metadata.originalCodec, 'bytevc2');
    assert.equal(metadata.conversion, 'libx264-v1');
    assert.equal(metadata.codec, 'h264');
    assert.equal(metadata.mediaSource, 'app');
    const cached = await prepare(h, 10, { requestId: 'second' });
    assert.equal(cached.cached, true, 'validated conversion is reused without re-converting');
    assert.equal(conversions.length, 1);
    await h.handlers['release-online-play']({}, { streamId: first.streamId });
    await h.handlers['release-online-play']({}, { streamId: cached.streamId });
  }],
  ['ByteVC2 preparation reports downloading and transcoding phases with percent', async () => {
    const h = load(null, { playInfo: bytevc2PlayInfo }), conversions = [];
    installH264Probe(h);
    h.context.sendToRenderer = (name, payload) => { if (name === 'online-play-progress') h.progressEvents.push(payload); };
    h.progressEvents = [];
    installConversionStub(h, conversions);
    window(h, 10);
    const result = await prepare(h, 10);
    assert.equal(result.success, true, result.error);
    const phases = h.progressEvents.map(e => e.phase);
    assert.ok(phases.includes('downloading'), 'download phase must be reported');
    assert.ok(phases.includes('transcoding'), 'conversion phase must be reported');
    const lastTranscode = [...h.progressEvents].reverse().find(e => e.phase === 'transcoding');
    assert.equal(lastTranscode.total, bytevc2PlayInfo.duration, 'conversion progress totals the episode duration');
    await h.handlers['release-online-play']({}, { streamId: result.streamId });
  }],
  ['prefetch conversion queues as next episode and is promoted without restarting', async () => {
    const h = load(null, { playInfo: bytevc2PlayInfo }), conversions = [], gate = defer(), started = defer();
    installH264Probe(h); installConversionStub(h, conversions, gate, started);
    window(h, 10);
    const background = prepare(h, 11, { prefetch: true });
    await Promise.race([started.promise, background.then(result => assert.fail(result.error || 'prefetch finished before conversion'))]);
    assert.equal(conversions.length, 1, 'prefetch reaches the conversion');
    assert.equal(conversions[0].priorityAtStart, CONVERSION_PRIORITIES.next, 'next playable episode queues above downloads');
    const foreground = prepare(h, 11);
    gate.resolve();
    const settled = await foreground;
    assert.equal(settled.success, true, settled.error);
    assert.equal(conversions.length, 1, 'foreground takeover keeps the same conversion');
    assert.equal(conversions[0].priorityAfterGate, CONVERSION_PRIORITIES.playback, 'promotion raises the live priority');
    await background.then(r => assert.equal(r.success, true));
    await h.handlers['release-online-play']({}, { streamId: settled.streamId });
  }],
  ['cancelling the last consumer stops the conversion and cleans up partial output', async () => {
    const h = load(null, { playInfo: bytevc2PlayInfo }), conversions = [], gate = defer(), started = defer();
    installH264Probe(h); installConversionStub(h, conversions, gate, started);
    window(h, 10);
    const request = prepare(h, 10, { requestId: 'solo' });
    await Promise.race([started.promise, request.then(result => assert.fail(result.error || 'playback finished before conversion'))]);
    assert.equal(conversions.length, 1);
    const directory = path.dirname(conversions[0].output);
    await h.handlers['release-online-play']({}, { requestId: 'solo' });
    gate.resolve();
    const result = await request;
    assert.equal(result.success, false);
    assert.match(result.error, /已取消/);
    assert.equal(fs.existsSync(directory), false, 'the managed temporary directory is removed');
    assert.equal(h.run("onlinePreparing.size"), 0);
  }],
  ['missing helper fails the episode with an explicit message', async () => {
    const h = load(null, { playInfo: bytevc2PlayInfo });
    installH264Probe(h);
    h.context.resolveFfmpeg = () => null; // no librempeg anywhere
    window(h, 10);
    const result = await prepare(h, 10);
    assert.equal(result.success, false);
    assert.match(result.error, /ByteVC2.*组件/);
  }],
  ['non-disk playback converts ByteVC2 into a managed file entry', async () => {
    const h = load(null, { playInfo: bytevc2PlayInfo }), conversions = [];
    installH264Probe(h); installConversionStub(h, conversions);
    const result = await h.handlers['prepare-online-play']({}, { vid: 'v1', seriesId: 'S', vidIndex: 1, requestId: 'nd-1' });
    assert.equal(result.success, true, result.error);
    assert.equal(result.codec, 'h264');
    const entry = h.run("onlineCache.get('v1')");
    assert.ok(entry.filePath, 'the converted episode must be served from a managed file');
    assert.equal(entry.buffer, undefined);
    assert.equal(entry.playInfo, undefined);
    assert.equal(entry.originalCodec, 'bytevc2');
    assert.ok(fs.existsSync(entry.filePath));
    await h.handlers['release-online-play']({}, { streamId: result.streamId });
  }],
  ['compat mode reuses the converted H.264 directly instead of re-encoding', async () => {
    const h = load(null, { playInfo: bytevc2PlayInfo }), conversions = [];
    installH264Probe(h); installConversionStub(h, conversions);
    window(h, 10);
    const prepared = await prepare(h, 10);
    assert.equal(prepared.success, true, prepared.error);
    const reused = await h.handlers['transcode-for-playback']({}, { seriesId: 'S', vid: 'v10', vidIndex: 10,
      quality: 'auto', requestId: 'compat-reuse', streamId: prepared.streamId, reason: 'compat-mode', codec: 'h264' });
    assert.equal(reused.success, true, reused.error);
    assert.equal(reused.original, true, 'validated converted H.264 must bypass compatibility encoding');
    assert.equal(conversions.length, 1, 'compat mode must not trigger another conversion');
    await h.handlers['release-online-play']({}, { streamId: prepared.streamId });
  }],
  ['manual download converts through the shared queue and publishes a verified file', async () => {
    const h = downloadFixture();
    await h.handlers['hongguo-download-batch']({}, { seriesId: '1', seriesTitle: '测试剧', episodes: [{ vid: '11', vid_index: 1 }] });
    await h.run("executeHongguoDownload(downloadTasks[0])");
    const task = h.saved()[0];
    assert.equal(task.status, 'completed', task.error);
    assert.equal(task.actualQuality, '1080p');
    assert.ok(fs.existsSync(task.savePath));
    assert.equal(fs.statSync(task.savePath).size, 4096);
    assert.equal(h.conversions.length, 1);
    assert.equal(h.conversions[0].priority, CONVERSION_PRIORITIES.download, 'downloads queue below playback');
    assert.equal(h.conversions[0].hadToken, true, 'download cancellation token reaches the conversion');
    const staged = h.events.filter(e => e.name === 'download-progress' && e.stage);
    assert.ok(staged.some(e => e.stage === 'transcoding'), 'conversion stage is visible in download progress');
    assert.ok(!fs.existsSync(task.savePath + '.enc.tmp'), 'temporary input is cleaned');
    assert.ok(!fs.existsSync(task.savePath + '.enc.tmp.h264'), 'temporary conversion output is cleaned');
  }],
  ['failed download conversion preserves the retry state and publishes nothing', async () => {
    const h = downloadFixture();
    h.context.convertBytevc2ToH264 = async (_input, output) => {
      fs.writeFileSync(output, Buffer.alloc(64, 1));
      throw Object.assign(new Error('ByteVC2 转码失败，请重新获取片源后重试'), { code: 'BYTEVC2_CONVERSION_FAILED' });
    };
    await h.handlers['hongguo-download-batch']({}, { seriesId: '1', seriesTitle: '测试剧', episodes: [{ vid: '11', vid_index: 1 }] });
    await h.run("executeHongguoDownload(downloadTasks[0])");
    const task = h.saved()[0];
    assert.equal(task.status, 'failed');
    assert.match(task.error, /ByteVC2 转码失败/);
    assert.equal(fs.existsSync(task.savePath), false, 'no partial file may be published');
  }],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
  }
  console.log(`${checks.length - failed}/${checks.length} bytevc2 main-process checks passed`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => roots.forEach(root => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }));
