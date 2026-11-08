// SPDX-License-Identifier: GPL-3.0-only
// ByteVC2 -> H.264 conversion on the bundled Librempeg helper (bvc2 decoder).
// Playback, next-episode prefetch and manual downloads share one CPU budget:
// a single helper process runs at a time and an active conversion is never
// restarted when its episode is promoted to the foreground.
const fs = require('node:fs/promises');

// Queue levels: current playback > next playable episode > manual download >
// distant prefetch. Entries at the same level keep arrival order.
const CONVERSION_PRIORITIES = Object.freeze({ playback: 3, next: 2, download: 1, background: 0 });

const waiting = [];
let converting = false;
const abortError = () => Object.assign(new Error('已取消 ByteVC2 转码'), { code: 'ERR_CANCELED' });

function drain() {
  if (converting || !waiting.length) return;
  waiting.sort((a, b) => b.getPriority() - a.getPriority());
  const next = waiting.shift();
  converting = true;
  next.cleanup();
  next.resolve(() => { converting = false; drain(); });
}

function acquire(signal, cancelToken, getPriority) {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const index = waiting.indexOf(entry);
      if (index === -1) return;
      waiting.splice(index, 1);
      entry.cleanup();
      reject(abortError());
    };
    const entry = { resolve, getPriority, cleanup: () => {
      signal?.removeEventListener('abort', cancel);
      cancelToken?.unsubscribe(cancel);
    } };
    waiting.push(entry);
    signal?.addEventListener('abort', cancel, { once: true });
    cancelToken?.subscribe(cancel);
    if (signal?.aborted || cancelToken?.reason) cancel();
    drain();
  });
}

function runHelper(executable, args, { signal, cancelToken, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let killTimer, buffer = '', stopping = false, diskFull = false, diagnosticTail = '';
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref?.();
    };
    const cleanup = () => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      cancelToken?.unsubscribe(stop);
    };
    child.stdout.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) onProgress?.(Number(match[1]) / 1e6);
      }
    });
    // Native diagnostics may include private paths and content keys. Only the
    // disk-full marker is inspected; our own messages are reported instead.
    child.stderr.on('data', data => {
      const diagnostic = diagnosticTail + data.toString();
      diskFull ||= /\bNo space left on device\b|\bENOSPC\b/i.test(diagnostic);
      diagnosticTail = diagnostic.slice(-80);
    });
    child.once('error', () => { cleanup(); reject(new Error('无法启动内置 ByteVC2 解码组件')); });
    child.once('close', code => {
      cleanup();
      if (stopping || signal?.aborted || cancelToken?.reason) reject(abortError());
      else if (diskFull) {
        reject(Object.assign(new Error('磁盘空间不足，无法完成本集转码'), { code: 'ENOSPC' }));
      } else resolve(code);
    });
    signal?.addEventListener('abort', stop, { once: true });
    cancelToken?.subscribe(stop);
    if (signal?.aborted || cancelToken?.reason) stop();
  });
}

async function runConversion({ executable, args, output, duration, maxBytes, signal, cancelToken, onProgress, verifyOutput }) {
  const file = await fs.open(output, 'wx', 0o600);
  await file.close();
  try {
    let seconds = 0;
    const code = await runHelper(executable, args, { signal, cancelToken, onProgress: value => { seconds = value; onProgress?.(value); } });
    if (signal?.aborted || cancelToken?.reason) throw abortError();
    if (code !== 0) throw Object.assign(new Error('ByteVC2 转码失败，请重新获取片源后重试'), { code: 'BYTEVC2_CONVERSION_FAILED' });
    const size = (await fs.stat(output)).size;
    if (Number.isFinite(maxBytes) && size >= maxBytes) {
      throw Object.assign(new Error('本集转码后过大，请下载后播放'), { code: 'MEDIA_TOO_LARGE' });
    }
    if (!size || seconds < duration - 1) throw new Error('ByteVC2 转码结果不完整，请重试本集');
    const verified = await verifyOutput?.(output);
    if (signal?.aborted || cancelToken?.reason) throw abortError();
    return { size, verified };
  } catch (error) {
    await fs.unlink(output).catch(() => {});
    throw error;
  }
}

/**
 * Convert one complete ByteVC2 file to original-size H.264 with AAC audio.
 * The caller keeps the managed input, validates parameters beforehand and
 * supplies the FFprobe validation to run before accepting either encoder's output.
 */
async function convertBytevc2({ executable, input, output, contentKey, duration, signal, cancelToken, onProgress, onPhase,
  maxBytes = Infinity, getPriority = () => CONVERSION_PRIORITIES.playback, device = null, accelExecutable = null, verifyOutput }) {
  const cancelled = () => signal?.aborted || cancelToken?.reason;
  if (cancelled()) throw abortError();
  if (!executable) throw new Error('未找到内置 ByteVC2 解码组件，请重新下载完整版本后重试');
  if (contentKey != null && !/^[a-f\d]{32}$/i.test(contentKey)) throw new Error('片源解密密钥格式无效');
  if (!Number.isFinite(duration) || duration <= 0 || !(maxBytes > 0) || input === output) throw new Error('ByteVC2 视频参数无效');
  if (converting || waiting.length) onPhase?.('queued');
  const release = await acquire(signal, cancelToken, getPriority);
  try {
    if (cancelled()) throw abortError();
    onPhase?.('transcoding');
    const common = ['-y', '-hide_banner', '-loglevel', 'error', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-filter_threads', '1', '-threads:v', '2', ...(contentKey ? ['-decryption_key', contentKey] : []), '-i', input,
      '-map', '0:v:0', '-map', '0:a?'];
    const sizeLimit = Number.isFinite(maxBytes) ? ['-fs', String(maxBytes)] : [];
    // CPU decode + x264 veryfast/CRF 23; decoder and encoder get 2 threads
    // each, filters and x264 lookahead 1 thread each.
    const cpuArgs = [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-threads:v', '2', '-x264-params', 'lookahead_threads=1',
      '-c:a', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', ...sizeLimit, '-f', 'mp4', output];
    if (device && accelExecutable) {
      // Same CPU decode, frames uploaded as nv12 and encoded by the Intel device.
      const vaapiArgs = ['-vaapi_device', device, ...common, '-vf', 'format=nv12,hwupload',
        '-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', '23',
        '-c:a', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', ...sizeLimit, '-f', 'mp4', output];
      try {
        const result = await runConversion({ executable: accelExecutable, args: vaapiArgs, output, duration, maxBytes, signal, cancelToken, onProgress, verifyOutput });
        return { ...result, codec: 'h264', encoder: 'h264_vaapi' };
      } catch (error) {
        if (cancelled() || error.code === 'ENOSPC') throw error;
        // One clean retry on the always-available CPU path with the same input.
      }
    }
    const result = await runConversion({ executable, args: cpuArgs, output, duration, maxBytes, signal, cancelToken, onProgress, verifyOutput });
    return { ...result, codec: 'h264', encoder: 'libx264' };
  } finally { release(); }
}

module.exports = { convertBytevc2, CONVERSION_PRIORITIES };
