// popup.js — Extension popup logic
'use strict';

let currentTabId = null;
let currentStreams = [];
let pageTitle = '';
let downloadId = null;
let progressInterval = null;

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  pageTitle = tab?.title || '';

  document.getElementById('pageTitle').textContent = pageTitle || '—';
  document.getElementById('btnRefresh').addEventListener('click', loadStreams);

  await loadStreams();

  // Listen for real-time stream additions
  chrome.runtime.onMessage.addListener(onMessage);
});

function onMessage(msg) {
  if (msg.action === 'STREAMS_UPDATED' && msg.tabId === currentTabId) {
    loadStreams();
  }
  if (msg.action === 'PROGRESS_UPDATE' && msg.downloadId === downloadId) {
    updateProgressUI(msg.stage, msg.percent);
  }
  if (msg.action === 'DOWNLOAD_COMPLETE' && msg.downloadId === downloadId) {
    updateProgressUI('done', 100);
  }
  if (msg.action === 'DOWNLOAD_ERROR' && msg.downloadId === downloadId) {
    showError(msg.error);
  }
}

// ── Load & render streams ────────────────────────────────────────────────────
async function loadStreams() {
  if (!currentTabId) return;

  const { streams, title } = await chrome.runtime.sendMessage({
    action: 'GET_STREAMS',
    tabId: currentTabId
  });

  currentStreams = streams || [];
  if (title) {
    pageTitle = title;
    document.getElementById('pageTitle').textContent = title;
  }

  renderStreams();
}

function renderStreams() {
  const list = document.getElementById('streamList');
  const countEl = document.getElementById('streamCount');

  // Clear previous (keep empty state)
  list.innerHTML = '';

  if (currentStreams.length === 0) {
    list.innerHTML = `
      <div class="empty-state" id="emptyState">
        <div class="empty-icon">📡</div>
        <div class="empty-title">No streams detected</div>
        <div class="empty-desc">Open a page with a video and play it. Detected streams will appear here automatically.</div>
      </div>`;
    countEl.classList.remove('show');
    return;
  }

  countEl.textContent = currentStreams.length;
  countEl.classList.add('show');

  currentStreams.forEach((stream, idx) => {
    const card = buildStreamCard(stream, idx);
    list.appendChild(card);
  });
}

// ── Build a stream card DOM element ─────────────────────────────────────────
function buildStreamCard(stream, idx) {
  const card = document.createElement('div');
  card.className = 'stream-card';
  card.dataset.idx = idx;

  const typeLabel = stream.type === 'hls' ? 'HLS' : stream.type === 'dash' ? 'DASH' : 'DASH-MP4';
  const typeClass = stream.type === 'hls' ? 'hls' : stream.type === 'dash' ? 'dash' : 'dash-mp4';

  // Short ID for display
  const shortId = (() => {
    try {
      const u = new URL(stream.baseUrl);
      return u.pathname.split('/').filter(Boolean).slice(-1)[0] || u.hostname;
    } catch { return stream.baseUrl.slice(-40); }
  })();

  // Track info
  const hasVideo = stream.videoUrls?.length > 0;
  const hasAudio = stream.audioUrls?.length > 0;
  const hasManifest = !!stream.manifestUrl;

  // Video codec hint from URL
  const videoCodecHint = stream.videoUrls?.[0]
    ? (stream.videoUrls[0].match(/avc1|hvc1|vp9|hevc/i)?.[0]?.toUpperCase() || 'MP4') : '';
  const audioCodecHint = stream.audioUrls?.[0]
    ? (stream.audioUrls[0].match(/mp4a|aac|ac3|ec3/i)?.[0]?.toUpperCase() || 'AAC') : '';

  // Audio language hint
  const audioLangHint = stream.audioUrls?.[0]
    ? (stream.audioUrls[0].match(/media-audio-([a-z]{2,3})-/i)?.[1]?.toUpperCase() || '') : '';

  card.innerHTML = `
    <div class="stream-header">
      <span class="type-badge ${typeClass}">${typeLabel}</span>
      <span class="stream-id" title="${stream.baseUrl}">${shortId}</span>
    </div>
    <div class="stream-body">
      <div class="tracks-grid" id="tracksGrid-${idx}">
        ${hasVideo ? `
          <div class="track-pill">
            <span class="icon">🎥</span>
            <div class="info">
              <span class="label">Video</span>
              <span class="value">${videoCodecHint || 'Track found'}</span>
            </div>
          </div>` : '<div class="track-pill" style="opacity:0.4"><span class="icon">🎥</span><div class="info"><span class="label">Video</span><span class="value">Not found</span></div></div>'}
        ${hasAudio ? `
          <div class="track-pill">
            <span class="icon">🔊</span>
            <div class="info">
              <span class="label">Audio${audioLangHint ? ` (${audioLangHint})` : ''}</span>
              <span class="value">${audioCodecHint || 'Track found'}</span>
            </div>
          </div>` : '<div class="track-pill" style="opacity:0.4"><span class="icon">🔊</span><div class="info"><span class="label">Audio</span><span class="value">Not found</span></div></div>'}
      </div>

      ${hasManifest ? `<div style="font-size:11px;color:#8882aa;margin-bottom:8px;">📋 Manifest: ${stream.manifestUrl.split('/').pop()}</div>` : ''}

      <button class="btn-download" id="dlBtn-${idx}" ${(!hasVideo && !hasManifest) ? 'disabled' : ''}>
        ⬇ Download ${(hasVideo && hasAudio) ? 'Video + Audio' : hasVideo ? 'Video' : 'Stream'}
      </button>

      <div class="progress-area" id="progress-${idx}">
        <div class="progress-label">
          <span class="stage" id="pStage-${idx}">Starting…</span>
          <span class="pct" id="pPct-${idx}">0%</span>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="pBar-${idx}"></div>
        </div>
      </div>
      <div class="status-msg" id="statusMsg-${idx}" style="display:none"></div>
    </div>
  `;

  // Attach download handler
  card.querySelector(`#dlBtn-${idx}`).addEventListener('click', () => startDownload(stream, idx));

  return card;
}

// ── Start download ──────────────────────────────────────────────────────────
async function startDownload(stream, idx) {
  downloadId = `dl-${Date.now()}-${idx}`;

  const btn = document.getElementById(`dlBtn-${idx}`);
  const progressArea = document.getElementById(`progress-${idx}`);
  const statusMsg = document.getElementById(`statusMsg-${idx}`);
  btn.disabled = true;
  btn.innerHTML = '<span class="spinning">⟳</span> Preparing…';
  progressArea.classList.add('show');
  statusMsg.style.display = 'none';

  // Determine filename from page title or URL
  const filename = sanitizeFilename(pageTitle || stream.baseUrl.split('/').filter(Boolean).pop() || 'video');

  // For HLS: fetch and parse manifest first
  let downloadStream = { ...stream };
  if (stream.type === 'hls' && stream.manifestUrl) {
    try {
      updateProgressUI('fetching_manifest', 5, idx);
      const resp = await fetch(stream.manifestUrl);
      const text = await resp.text();

      // Lazy-load m3u8 parser
      const { parseM3U8 } = await import(chrome.runtime.getURL('lib/m3u8-parser.js'));
      const parsed = parseM3U8(text, stream.manifestUrl);

      if (parsed.type === 'master') {
        // Use best quality variant
        const variant = parsed.variants[0];
        if (variant?.url) {
          const mediaResp = await fetch(variant.url);
          const mediaText = await mediaResp.text();
          const mediaParsed = parseM3U8(mediaText, variant.url);
          downloadStream.segments = mediaParsed.segments;
          downloadStream.initSegment = mediaParsed.initSegment;
          downloadStream.encrypted = mediaParsed.encrypted;
        }
      } else {
        downloadStream.segments = parsed.segments;
        downloadStream.initSegment = parsed.initSegment;
        downloadStream.encrypted = parsed.encrypted;
      }

      if (downloadStream.encrypted) {
        showError('This stream is encrypted and cannot be downloaded.', idx);
        btn.disabled = false;
        btn.innerHTML = '⬇ Download';
        return;
      }
    } catch (err) {
      showError('Failed to parse stream manifest: ' + err.message, idx);
      btn.disabled = false;
      btn.innerHTML = '⬇ Download';
      return;
    }
  }

  // Send download task to background
  await chrome.runtime.sendMessage({
    action: 'START_DOWNLOAD',
    downloadId,
    stream: downloadStream,
    filename,
    selectedVideoUrl: stream.videoUrls?.[0] || null,
    selectedAudioUrl: stream.audioUrls?.[0] || null
  });

  // Poll for progress as fallback
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(async () => {
    const { progress } = await chrome.runtime.sendMessage({ action: 'GET_PROGRESS', downloadId });
    if (!progress) return;
    updateProgressUI(progress.stage, progress.percent, idx);
    if (progress.stage === 'done' || progress.stage === 'error') {
      clearInterval(progressInterval);
      if (progress.stage === 'done') {
        showSuccess('Download complete! Check your Downloads folder.', idx);
        btn.innerHTML = '✓ Downloaded';
      } else {
        showError(progress.error || 'Download failed', idx);
        btn.disabled = false;
        btn.innerHTML = '⬇ Retry';
      }
    }
  }, 500);
}

// ── Progress helpers ─────────────────────────────────────────────────────────
const STAGE_LABELS = {
  starting: 'Starting…',
  loading_ffmpeg: 'Loading ffmpeg…',
  fetching_manifest: 'Fetching manifest…',
  fetching_video: 'Downloading video…',
  fetching_audio: 'Downloading audio…',
  fetching_segments: 'Downloading segments…',
  muxing: 'Merging tracks…',
  done: 'Complete!',
  error: 'Error'
};

function updateProgressUI(stage, percent, idx) {
  // Find card index from downloadId or use active card
  const cards = document.querySelectorAll('.stream-card');
  cards.forEach((card, i) => {
    const progressArea = document.getElementById(`progress-${i}`);
    if (!progressArea?.classList.contains('show')) return;

    const stageEl = document.getElementById(`pStage-${i}`);
    const pctEl = document.getElementById(`pPct-${i}`);
    const barEl = document.getElementById(`pBar-${i}`);
    const btn = document.getElementById(`dlBtn-${i}`);

    if (stageEl) stageEl.textContent = STAGE_LABELS[stage] || stage;
    if (pctEl) pctEl.textContent = `${percent}%`;
    if (barEl) barEl.style.width = `${percent}%`;
    if (stage === 'done') {
      if (btn) { btn.innerHTML = '✓ Downloaded'; btn.disabled = true; }
      showSuccess('Download complete! Check your Downloads folder.', i);
    }
  });
}

function showSuccess(msg, idx) {
  const el = document.getElementById(`statusMsg-${idx}`);
  if (!el) return;
  el.className = 'status-msg success';
  el.textContent = '✓ ' + msg;
  el.style.display = 'block';
}

function showError(msg, idx) {
  // Try to find which card is active
  const cards = document.querySelectorAll('.stream-card');
  const i = idx !== undefined ? idx : 0;
  const el = document.getElementById(`statusMsg-${i}`);
  if (!el) return;
  el.className = 'status-msg error';
  el.textContent = '✗ ' + msg;
  el.style.display = 'block';
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '_').slice(0, 120) || 'video';
}
