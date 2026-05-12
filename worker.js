/**
 * AdobeNative — Zero‑auth, fully automatic Player Proxy
 *
 * Run locally: wrangler dev --port 3000   (or any port)
 *
 * Endpoints (all public):
 *   /                                          → Plain text listing of all endpoints
 *   /proxy/playlist.m3u8?url=<ENCODED_URL>     → M3U8 proxy (rewrites segments)
 *   /proxy/segment?url=<ENCODED_SEGMENT_URL>   → Segment proxy (pass‑through)
 *   /player?video=<stream_url>                 → HTML5 player (HLS.js)
 *   /embed?video=<stream_url>                  → Minimal iframe player
 *   /share?video=<stream_url>                  → Get share URLs / embed code
 *   /playback.json?video=<stream_url>          → JSON playback manifest
 *   /thumb/...                                  → Placeholder
 *
 * No secrets, no keys – it just works.
 */

// ========== CORS ==========
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
    'Vary': 'Origin'
  };
}

function addCors(response, request) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// ========== Player HTML (unchanged, used by /player and /embed) ==========
function playerHTML(videoUrl, isEmbed = false) {
  const manifestUrl = `/proxy/playlist.m3u8?url=${encodeURIComponent(videoUrl)}`;
  const style = isEmbed
    ? 'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}video{width:100%;height:100%;object-fit:contain}'
    : 'body{font-family:system-ui;background:#000;color:#fff;text-align:center}video{max-width:100%;max-height:80vh}';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isEmbed ? 'AdobeNative Embed' : 'AdobeNative Player'}</title>
  <style>${style}</style>
</head>
<body>
${isEmbed ? '' : '<h1 style="margin:1rem">AdobeNative Player</h1>'}
<video id="video" controls ${isEmbed ? '' : 'autoplay'}></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
  const video = document.getElementById('video');
  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource("${manifestUrl}");
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = "${manifestUrl}";
  }
</script>
</body>
</html>`;
}

// ========== Proxy helpers ==========
function rewritePlaylist(text, proxyBase) {
  const lines = text.split('\n');
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const segUrl = encodeURIComponent(trimmed);
      return `${proxyBase}/proxy/segment?url=${segUrl}`;
    }
    return line;
  });
  return rewritten.join('\n');
}

// ========== Main handler ==========
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const baseUrl = `${url.protocol}//${url.host}`;

    // ----- Root: plain text endpoint list (no CSS) -----
    if (path === '/') {
      const text = `AdobeNativePlayer - Zero Auth Proxy\n` +
        `Proxy running at: ${baseUrl}\n\n` +
        `Endpoints:\n\n` +
        `1.  M3U8 Proxy\n` +
        `    ${baseUrl}/proxy/playlist.m3u8?url=<ENCODED_STREAM_URL>\n\n` +
        `2.  Segment Proxy\n` +
        `    ${baseUrl}/proxy/segment?url=<ENCODED_SEGMENT_URL>\n\n` +
        `3.  HTML5 Player\n` +
        `    ${baseUrl}/player?video=<ENCODED_STREAM_URL>\n\n` +
        `4.  Embed Player (iframe)\n` +
        `    ${baseUrl}/embed?video=<ENCODED_STREAM_URL>\n\n` +
        `5.  Share Link Generator\n` +
        `    ${baseUrl}/share?video=<ENCODED_STREAM_URL>\n\n` +
        `6.  JSON Playback Manifest\n` +
        `    ${baseUrl}/playback.json?video=<ENCODED_STREAM_URL>\n\n` +
        `7.  Thumbnails (placeholder)\n` +
        `    ${baseUrl}/thumb/...\n\n` +
        `All endpoints are public – no authentication required.`;
      return new Response(text, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // ----- Public: share -----
    if (path === '/share') {
      const videoUrl = url.searchParams.get('video');
      if (!videoUrl) {
        return new Response(JSON.stringify({ error: 'Missing ?video= parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }
      const playerUrl = `${baseUrl}/player?video=${encodeURIComponent(videoUrl)}`;
      const embedUrl = `${baseUrl}/embed?video=${encodeURIComponent(videoUrl)}`;
      const embedCode = `<iframe src="${embedUrl}" style="width:100%;aspect-ratio:16/9" frameborder="0" allowfullscreen></iframe>`;
      return new Response(JSON.stringify({ playerUrl, embedUrl, embedCode }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders() }
      });
    }

    // ----- Proxy: playlist -----
    if (path === '/proxy/playlist.m3u8') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return new Response('Missing url parameter', { status: 400 });

      const resp = await fetch(targetUrl, {
        headers: { 'User-Agent': request.headers.get('User-Agent') || 'AdobeNative/1.0' }
      });
      if (!resp.ok) return new Response(`Failed to fetch playlist: ${resp.status}`, { status: 502 });

      const text = await resp.text();
      const modified = rewritePlaylist(text, baseUrl);
      return new Response(modified, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=5',
          ...corsHeaders()
        }
      });
    }

    // ----- Proxy: segment -----
    if (path === '/proxy/segment') {
      const segUrl = url.searchParams.get('url');
      if (!segUrl) return new Response('Missing url parameter', { status: 400 });

      const headers = new Headers(request.headers);
      headers.delete('Host');
      const segmentResp = await fetch(segUrl, { headers });
      if (!segmentResp.ok) return new Response(`Failed to fetch segment: ${segmentResp.status}`, { status: 502 });

      const responseHeaders = new Headers();
      responseHeaders.set('Content-Type', segmentResp.headers.get('content-type') || 'video/MP2T');
      responseHeaders.set('Accept-Ranges', 'bytes');
      responseHeaders.set('Cache-Control', 'public, max-age=31536000');
      Object.entries(corsHeaders()).forEach(([k, v]) => responseHeaders.set(k, v));

      const cr = segmentResp.headers.get('content-range');
      if (cr) responseHeaders.set('Content-Range', cr);
      const cl = segmentResp.headers.get('content-length');
      if (cl) responseHeaders.set('Content-Length', cl);

      return new Response(segmentResp.body, {
        status: segmentResp.status,
        headers: responseHeaders
      });
    }

    // ----- Player page -----
    if (path === '/player') {
      const videoUrl = url.searchParams.get('video');
      if (!videoUrl) return addCors(new Response('Missing ?video= parameter', { status: 400 }), request);
      return new Response(playerHTML(videoUrl, false), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', ...corsHeaders() }
      });
    }

    // ----- Embed page -----
    if (path === '/embed') {
      const videoUrl = url.searchParams.get('video');
      if (!videoUrl) return addCors(new Response('Missing ?video= parameter', { status: 400 }), request);
      return new Response(playerHTML(videoUrl, true), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', ...corsHeaders() }
      });
    }

    // ----- JSON playback -----
    if (path === '/playback.json') {
      const videoUrl = url.searchParams.get('video');
      if (!videoUrl) return addCors(new Response('Missing ?video= parameter', { status: 400 }), request);
      const data = {
        url: videoUrl,
        hls: `${baseUrl}/proxy/playlist.m3u8?url=${encodeURIComponent(videoUrl)}`,
        title: 'AdobeNative Stream',
        metadata: { adobeNative: true }
      };
      return addCors(new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
      }), request);
    }

    // Placeholder thumbnails
    if (path.startsWith('/thumb/')) {
      return addCors(new Response('Thumbnail placeholder – no origin', { status: 404 }), request);
    }

    // Fallback 404
    return addCors(new Response('Not Found', { status: 404 }), request);
  }
};
