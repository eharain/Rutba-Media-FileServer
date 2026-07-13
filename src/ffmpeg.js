'use strict';

/**
 * ffmpeg/ffprobe wrapper for video (and audio) processing. Like `sharp`, it
 * degrades gracefully: if no binary is found, `enabled` is false and callers fall
 * back to streaming the master untouched (exactly as before this feature existed).
 *
 * Binary resolution order: FFMPEG_PATH / FFPROBE_PATH env → the bundled
 * `ffmpeg-static` / `ffprobe-static` packages → `ffmpeg` / `ffprobe` on PATH.
 *
 * Provides:
 *   probe(path)                        → { durationSec, width, height, videoCodec, audioCodec, bitRate, fps }
 *   posterBuffer(path, { t, w, h })    → JPEG bytes of a single frame at time `t`
 *   transcodeToFile(path, out, opts)   → transcode to H.264/AAC MP4 (optionally scaled)
 *
 * All spawns are time-boxed and never throw into the request path — callers treat a
 * rejection as "couldn't process, stream the original / 404".
 */

const { spawn, execFile } = require('child_process');

function resolveBinary(envPath, staticPkg, fallback) {
  if (envPath) return envPath;
  try { const p = require(staticPkg); return typeof p === 'string' ? p : (p && p.path) || fallback; } catch { return fallback; }
}

function createFfmpeg(config = {}) {
  const ffmpegPath = resolveBinary(process.env.FFMPEG_PATH, 'ffmpeg-static', 'ffmpeg');
  const ffprobePath = resolveBinary(process.env.FFPROBE_PATH, 'ffprobe-static', 'ffprobe');
  const timeoutMs = parseInt(process.env.FFMPEG_TIMEOUT_MS, 10) || 60000;

  // Probe availability once (async), memoized. `enabled` starts optimistic and is
  // corrected by init(); callers can also await `ready`.
  let enabled = !!ffmpegPath;
  const ready = new Promise((resolve) => {
    execFile(ffmpegPath, ['-version'], { timeout: 8000 }, (err) => { enabled = !err; resolve(enabled); });
  });

  // Run a binary, collecting stdout as a Buffer. Rejects on non-zero exit/timeout.
  function run(bin, args, { wantStdout = false } = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { windowsHide: true });
      const out = [], errBuf = [];
      let killed = false;
      const timer = setTimeout(() => { killed = true; proc.kill('SIGKILL'); }, timeoutMs);
      if (wantStdout) proc.stdout.on('data', (d) => out.push(d)); else proc.stdout.resume();
      proc.stderr.on('data', (d) => { if (errBuf.length < 64) errBuf.push(d); });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killed) return reject(new Error('ffmpeg timeout'));
        if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(errBuf).toString().slice(-300)}`));
        resolve(Buffer.concat(out));
      });
    });
  }

  return {
    get enabled() { return enabled; },
    ready,
    ffmpegPath,
    ffprobePath,

    // Structured media metadata via ffprobe (JSON).
    async probe(input) {
      const buf = await run(ffprobePath, [
        '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input,
      ], { wantStdout: true });
      let json; try { json = JSON.parse(buf.toString()); } catch { return null; }
      const streams = json.streams || [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      const fmt = json.format || {};
      let fps = null;
      if (v && v.avg_frame_rate && v.avg_frame_rate !== '0/0') {
        const [n, d] = v.avg_frame_rate.split('/').map(Number);
        if (d) fps = Math.round((n / d) * 100) / 100;
      }
      return {
        durationSec: fmt.duration != null ? Math.round(Number(fmt.duration) * 100) / 100 : (v && v.duration ? Number(v.duration) : null),
        width: v ? v.width || null : null,
        height: v ? v.height || null : null,
        videoCodec: v ? v.codec_name || null : null,
        audioCodec: a ? a.codec_name || null : null,
        bitRate: fmt.bit_rate ? Number(fmt.bit_rate) : null,
        fps,
      };
    },

    // A single frame at time `t` seconds as JPEG bytes (optionally scaled to fit
    // w×h). Uses `-ss` before `-i` for a fast keyframe seek.
    async posterBuffer(input, { t = 1, w = 0, h = 0 } = {}) {
      const args = ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', input, '-frames:v', '1'];
      if (w || h) args.push('-vf', `scale=${w || -1}:${h || -1}:force_original_aspect_ratio=decrease`);
      args.push('-f', 'image2', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1');
      return run(ffmpegPath, args, { wantStdout: true });
    },

    // Transcode to a web-friendly H.264/AAC MP4, optionally scaled to `height` px.
    // Writes to `out` (a temp path the caller renames into the cache).
    async transcodeToFile(input, out, { height = 0, crf = 24 } = {}) {
      const args = ['-y', '-loglevel', 'error', '-i', input,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p'];
      if (height) args.push('-vf', `scale=-2:${height}`);
      args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out);
      await run(ffmpegPath, args);
      return out;
    },
  };
}

module.exports = { createFfmpeg };
