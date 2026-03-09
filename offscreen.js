// offscreen.js — runs in a persistent offscreen document
// ffmpeg.js is loaded via <script> tag in offscreen.html (local extension file, no CSP issues)
// Merges DASH-MP4 video+audio tracks or HLS segment arrays into a single .mp4

let ffmpegInstance = null;

// ── Init ffmpeg using locally bundled core files ──────────────────────────────
async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;

  // `FFmpegWASM` is exposed as a global by the UMD build in lib/ffmpeg/ffmpeg.js
  const { FFmpeg } = window.FFmpegWASM;
  const ff = new FFmpeg();

  // Point to local extension files — chrome.runtime.getURL returns a chrome-extension:// URL
  // which is always accessible from extension pages without CSP issues
  const coreURL = chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js');
  const wasmURL = chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.wasm');

  await ff.load({ coreURL, wasmURL });
  ffmpegInstance = ff;
  return ff;
}

// ── Fetch with progress ───────────────────────────────────────────────────────
async function fetchBytes(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);

  const total = parseInt(resp.headers.get('content-length') || '0');
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total && onProgress) onProgress(received / total);
  }

  // Assemble into a single Uint8Array
  const result = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { result.set(c, pos); pos += c.length; }
  return result;
}

// ── Fetch all HLS segments in order ──────────────────────────────────────────
async function fetchAllSegments(segments, onProgress) {
  const parts = [];
  let totalBytes = 0;

  for (let i = 0; i < segments.length; i++) {
    const data = await fetchBytes(segments[i].url, null);
    parts.push(data);
    totalBytes += data.length;
    if (onProgress) onProgress((i + 1) / segments.length);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const p of parts) { merged.set(p, offset); offset += p.length; }
  return merged;
}

// ── Trigger browser download from a blob ──────────────────────────────────────
function triggerDownload(data, mimeType, filename) {
  const blob = new Blob([data], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  // Ask background service worker to call chrome.downloads.download()
  chrome.runtime.sendMessage({ action: 'TRIGGER_DOWNLOAD', blobUrl, filename })
    .catch(() => {
      // Fallback: create <a> tag
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
    });
}

// ── Main download handler ─────────────────────────────────────────────────────
async function handleDownload({ downloadId, stream, filename, selectedVideoUrl, selectedAudioUrl }) {

  function progress(stage, percent) {
    chrome.runtime.sendMessage({ action: 'MUX_PROGRESS', downloadId, stage, percent }).catch(() => {});
  }

  try {
    const safeFilename = (filename || 'video')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 120) + '.mp4';

    // ── DASH-MP4: separate video + audio files ────────────────────────────────
    if (stream.type === 'dash-mp4' || (selectedVideoUrl && selectedAudioUrl)) {
      const videoUrl = selectedVideoUrl || stream.videoUrls?.[0];
      const audioUrl = selectedAudioUrl || stream.audioUrls?.[0];

      if (!videoUrl) throw new Error('No video URL found in stream');
      if (!audioUrl) throw new Error('No audio URL found in stream');

      progress('loading_ffmpeg', 0);
      const ff = await getFFmpeg();
      progress('loading_ffmpeg', 100);

      progress('fetching_video', 0);
      const videoData = await fetchBytes(videoUrl, p => progress('fetching_video', Math.round(p * 100)));

      progress('fetching_audio', 0);
      const audioData = await fetchBytes(audioUrl, p => progress('fetching_audio', Math.round(p * 100)));

      progress('muxing', 10);
      await ff.writeFile('video.mp4', videoData);
      await ff.writeFile('audio.mp4', audioData);

      await ff.exec(['-i', 'video.mp4', '-i', 'audio.mp4', '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);
      progress('muxing', 90);

      const output = await ff.readFile('output.mp4');
      await ff.deleteFile('video.mp4').catch(() => {});
      await ff.deleteFile('audio.mp4').catch(() => {});
      await ff.deleteFile('output.mp4').catch(() => {});

      triggerDownload(output, 'video/mp4', safeFilename);
      chrome.runtime.sendMessage({ action: 'MUX_COMPLETE', downloadId, filename: safeFilename }).catch(() => {});

    // ── HLS: array of segment URLs ────────────────────────────────────────────
    } else if (stream.segments?.length) {
      if (stream.encrypted) throw new Error('Stream is encrypted — cannot download');

      progress('loading_ffmpeg', 0);
      const ff = await getFFmpeg();
      progress('loading_ffmpeg', 100);

      // Optionally fetch initialization segment (fMP4)
      let initData = null;
      if (stream.initSegment) {
        initData = await fetchBytes(stream.initSegment, null);
      }

      progress('fetching_segments', 0);
      const segData = await fetchAllSegments(stream.segments, p => progress('fetching_segments', Math.round(p * 100)));

      progress('muxing', 10);
      const isFmp4 = !!stream.initSegment;
      const ext = isFmp4 ? 'mp4' : 'ts';

      let inputData;
      if (initData) {
        inputData = new Uint8Array(initData.length + segData.length);
        inputData.set(initData);
        inputData.set(segData, initData.length);
      } else {
        inputData = segData;
      }

      await ff.writeFile(`input.${ext}`, inputData);
      await ff.exec(['-i', `input.${ext}`, '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);
      progress('muxing', 90);

      const output = await ff.readFile('output.mp4');
      await ff.deleteFile(`input.${ext}`).catch(() => {});
      await ff.deleteFile('output.mp4').catch(() => {});

      triggerDownload(output, 'video/mp4', safeFilename);
      chrome.runtime.sendMessage({ action: 'MUX_COMPLETE', downloadId, filename: safeFilename }).catch(() => {});

    } else {
      throw new Error('No downloadable content found in this stream');
    }

  } catch (err) {
    console.error('[PL Downloader offscreen error]', err);
    chrome.runtime.sendMessage({ action: 'MUX_ERROR', downloadId, error: String(err) }).catch(() => {});
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'OFFSCREEN_DOWNLOAD') {
    handleDownload(msg);
  }
});
