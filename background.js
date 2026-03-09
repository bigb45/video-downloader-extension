// background.js — Service Worker (MV3)
// Detects media stream URLs from all tabs, manages offscreen doc for muxing.

// ── Per-tab stream registry ──────────────────────────────────────────────────
// Map<tabId, { title: string, streams: Map<key, StreamEntry> }>
const tabRegistry = new Map();

// UUID-like pattern used to group DASH tracks by content
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Detect stream type from URL
function detectType(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/\.mpd(\?|$)/i.test(url)) return 'dash';
  if (/media-(video|audio)/i.test(url) && /\.mp4(\?|$)/i.test(url)) return 'dash-mp4';
  return null;
}

function getBaseKey(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(UUID_RE);
    if (m) {
      const idx = u.pathname.indexOf(m[0]);
      return u.origin + u.pathname.slice(0, idx + m[0].length);
    }
    // For manifests: use URL without query string
    return u.origin + u.pathname.replace(/[^/]+$/, '').replace(/\/$/, '');
  } catch {
    return url.split('?')[0].replace(/[^/]+$/, '');
  }
}

function ensureTab(tabId) {
  if (!tabRegistry.has(tabId)) {
    tabRegistry.set(tabId, { title: '', streams: new Map() });
  }
  return tabRegistry.get(tabId);
}

function recordUrl(tabId, url, type) {
  if (tabId < 0) return;
  const tab = ensureTab(tabId);
  const key = getBaseKey(url);

  if (!tab.streams.has(key)) {
    tab.streams.set(key, {
      id: key,
      baseUrl: key,
      type,
      manifestUrl: null,
      videoUrls: [],
      audioUrls: [],
      addedAt: Date.now()
    });
  }

  const s = tab.streams.get(key);

  if (type === 'hls' || type === 'dash') {
    s.manifestUrl = url.split('?')[0];
    s.type = type;
  } else if (type === 'dash-mp4') {
    if (/media-audio/i.test(url)) {
      if (!s.audioUrls.includes(url)) s.audioUrls.push(url);
    } else {
      if (!s.videoUrls.includes(url)) s.videoUrls.push(url);
    }
    if (!s.type || s.type === 'dash-mp4') s.type = 'dash-mp4';
    if (!s.manifestUrl) {
      // Guess manifest location
      s.manifestUrl = key + '/manifest.mpd';
    }
  }

  updateBadge(tabId, tab.streams.size);
  // Notify popup (silently ignore if closed)
  chrome.runtime.sendMessage({ action: 'STREAMS_UPDATED', tabId }).catch(() => {});
}

function updateBadge(tabId, count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId }).catch(() => {});
}

// ── Web Request Listener ─────────────────────────────────────────────────────
chrome.webRequest.onBeforeRequest.addListener(
  ({ url, tabId, type: reqType }) => {
    // Only inspect XHR, fetch, media and document requests
    if (!['xmlhttprequest', 'fetch', 'media', 'other', 'main_frame', 'sub_frame'].includes(reqType)) return;
    const type = detectType(url);
    if (type) recordUrl(tabId, url, type);
  },
  { urls: ['<all_urls>'] }
);

// ── Tab lifecycle ────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabRegistry.delete(tabId);
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener((tabId) => tabRegistry.delete(tabId));

// ── Offscreen Document ───────────────────────────────────────────────────────
let offscreenReady = false;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) { offscreenReady = true; return; }
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['BLOBS'],
    justification: 'Run ffmpeg.wasm to merge video and audio tracks'
  });
  offscreenReady = true;
}

// ── Download Progress ────────────────────────────────────────────────────────
const downloadProgress = new Map(); // downloadId → { stage, percent, error? }

// ── Message Handling ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'GET_STREAMS') {
    const tab = tabRegistry.get(msg.tabId);
    sendResponse({
      streams: tab ? Array.from(tab.streams.values()) : [],
      title: tab?.title || ''
    });
    return true;
  }

  if (msg.action === 'PAGE_INFO') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({}); return true; }
    const tab = ensureTab(tabId);
    if (msg.title) tab.title = msg.title;
    if (msg.urls?.length) {
      msg.urls.forEach(({ url, type }) => recordUrl(tabId, url, type));
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'START_DOWNLOAD') {
    handleDownload(msg).catch(err => {
      downloadProgress.set(msg.downloadId, { stage: 'error', percent: 0, error: String(err) });
      chrome.runtime.sendMessage({ action: 'DOWNLOAD_ERROR', downloadId: msg.downloadId, error: String(err) }).catch(() => {});
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'GET_PROGRESS') {
    sendResponse({ progress: downloadProgress.get(msg.downloadId) || null });
    return true;
  }

  // Relay from offscreen → popup
  if (msg.action === 'MUX_PROGRESS') {
    downloadProgress.set(msg.downloadId, { stage: msg.stage, percent: msg.percent });
    chrome.runtime.sendMessage({ action: 'PROGRESS_UPDATE', ...msg }).catch(() => {});
    return true;
  }

  if (msg.action === 'MUX_COMPLETE') {
    downloadProgress.set(msg.downloadId, { stage: 'done', percent: 100 });
    chrome.runtime.sendMessage({ action: 'DOWNLOAD_COMPLETE', downloadId: msg.downloadId, filename: msg.filename }).catch(() => {});
    return true;
  }

  if (msg.action === 'MUX_ERROR') {
    downloadProgress.set(msg.downloadId, { stage: 'error', percent: 0, error: msg.error });
    chrome.runtime.sendMessage({ action: 'DOWNLOAD_ERROR', downloadId: msg.downloadId, error: msg.error }).catch(() => {});
    return true;
  }

  if (msg.action === 'TRIGGER_DOWNLOAD') {
    // Called by offscreen document when it has the blob URL ready
    chrome.downloads.download({ url: msg.blobUrl, filename: msg.filename, saveAs: false });
    return true;
  }
});

async function handleDownload(msg) {
  const { downloadId, stream, filename, selectedVideoUrl, selectedAudioUrl } = msg;
  downloadProgress.set(downloadId, { stage: 'starting', percent: 0 });
  await ensureOffscreen();
  chrome.runtime.sendMessage({
    action: 'OFFSCREEN_DOWNLOAD',
    downloadId,
    stream,
    filename,
    selectedVideoUrl,
    selectedAudioUrl
  });
}
