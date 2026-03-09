// content.js — injected into every page
// Patches XHR/fetch to catch media URLs, sends page metadata to background.

(function () {
  'use strict';

  const MEDIA_RE = [
    /\.m3u8(\?|$)/i,
    /\.mpd(\?|$)/i,
    /media-(video|audio)[^/]*\.mp4(\?|$)/i
  ];

  function typeOf(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|$)/i.test(url)) return 'dash';
    if (/media-(video|audio)/i.test(url)) return 'dash-mp4';
    return null;
  }

  const seen = new Set();

  function report(url) {
    if (!url || typeof url !== 'string' || seen.has(url)) return;
    const type = typeOf(url);
    if (!type) return;
    seen.add(url);
    chrome.runtime.sendMessage({
      action: 'PAGE_INFO',
      title: getTitle(),
      urls: [{ url, type }]
    }).catch(() => {});
  }

  function getTitle() {
    const candidates = [
      // Structured metadata (most reliable)
      document.querySelector('meta[property="og:title"]')?.content,
      document.querySelector('meta[name="twitter:title"]')?.content,
      document.querySelector('meta[name="title"]')?.content,
      // Video element attributes
      document.querySelector('video[title]')?.title,
      document.querySelector('video[aria-label]')?.getAttribute('aria-label'),
      // Common video player heading patterns
      document.querySelector('[class*="video-title"]')?.textContent?.trim(),
      document.querySelector('[class*="player-title"]')?.textContent?.trim(),
      document.querySelector('[class*="episode-title"]')?.textContent?.trim(),
      document.querySelector('[data-video-title]')?.dataset?.videoTitle,
      // Page headings — prefer h1, fallback h2
      document.querySelector('h1')?.textContent?.trim(),
      document.querySelector('h2')?.textContent?.trim(),
      // Document title (often has site name appended — use as last resort)
      document.title,
    ].filter(t => t && t.length > 1 && t.length < 200);

    // Pick longest non-generic entry
    return candidates.sort((a, b) => b.length - a.length)[0] || '';
  }

  // Patch XMLHttpRequest
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string') report(url);
    return _open.apply(this, arguments);
  };

  // Patch fetch
  const _fetch = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
    report(url);
    return _fetch.apply(this, arguments);
  };

  // Send initial page info
  function sendPageInfo() {
    chrome.runtime.sendMessage({
      action: 'PAGE_INFO',
      title: getTitle(),
      urls: []
    }).catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sendPageInfo);
  } else {
    sendPageInfo();
  }

  // Watch for SPA title changes
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(sendPageInfo).observe(titleEl, { childList: true });
  }
})();
