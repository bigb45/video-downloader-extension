/**
 * Lightweight M3U8 parser — handles both master playlists and media playlists.
 */

export function parseM3U8(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const isMaster = lines.some(l => l.includes('#EXT-X-STREAM-INF'));
  return isMaster ? parseMasterPlaylist(lines, baseUrl) : parseMediaPlaylist(lines, baseUrl);
}

function resolveUrl(url, baseUrl) {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    const base = new URL(baseUrl);
    return base.origin + url;
  }
  const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  return base + url;
}

function parseAttributes(str) {
  const attrs = {};
  const regex = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]+?)(?=,[\w]|$)/g;
  let m;
  while ((m = regex.exec(str)) !== null) {
    attrs[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

function parseMasterPlaylist(lines, baseUrl) {
  const variants = [];
  const audioTracks = [];
  let pendingInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      pendingInfo = {
        bandwidth: parseInt(attrs.BANDWIDTH || '0'),
        resolution: attrs.RESOLUTION || '',
        codecs: attrs.CODECS || '',
        frameRate: attrs.FRAME_RATE || '',
        audio: attrs.AUDIO || '',
        url: null
      };
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.TYPE === 'AUDIO') {
        audioTracks.push({
          groupId: attrs['GROUP-ID'] || '',
          language: attrs.LANGUAGE || '',
          name: attrs.NAME || '',
          default: attrs.DEFAULT === 'YES',
          url: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : null
        });
      }
    } else if (pendingInfo && !line.startsWith('#')) {
      pendingInfo.url = resolveUrl(line, baseUrl);
      variants.push(pendingInfo);
      pendingInfo = null;
    }
  }

  // Sort by bandwidth descending
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return { type: 'master', variants, audioTracks };
}

function parseMediaPlaylist(lines, baseUrl) {
  const segments = [];
  let initSegment = null;
  let encryptionKey = null;
  let totalDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXTINF:')) {
      const dur = parseFloat(line.split(':')[1].split(',')[0]) || 0;
      const nextLine = lines[i + 1];
      if (nextLine && !nextLine.startsWith('#')) {
        segments.push({
          url: resolveUrl(nextLine, baseUrl),
          duration: dur,
          initSegment,
          key: encryptionKey
        });
        totalDuration += dur;
        i++;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) initSegment = resolveUrl(attrs.URI, baseUrl);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      encryptionKey = attrs.METHOD !== 'NONE' ? attrs : null;
    }
  }

  return {
    type: 'media',
    segments,
    totalDuration,
    encrypted: !!encryptionKey,
    initSegment
  };
}
