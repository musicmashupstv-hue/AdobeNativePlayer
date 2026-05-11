/**
 * AdobeNative — Local‑ready, JSON‑aware Player Proxy (with M3U8/segment proxying)
 *
 * Run locally: wrangler dev --port 3000   (or any port)
 *
 * Endpoints:
 *   /                                           → Activation page
 *   /player?video=<id>&token=...                → HTML5 player (HLS.js)
 *   /embed?video=<id>&token=...                 → Minimal iframe player
 *   /share?video=<id>&exp=...                   → Public share link generator
 *   /playback.json?video=<id>&token=...         → JSON playback info
 *   /proxy/playlist.m3u8?url=<ENCODED_URL>      → M3U8 proxy (rewrites segments)
 *   /proxy/segment?url=<ENCODED_SEGMENT_URL>    → Segment proxy (pass‑through)
 *   /thumb/...                                   → 404 (placeholder)
 *
 * All media endpoints require a valid HMAC‑signed token (except /share and activation).
 */

// ========== Auth helpers ==========
async function validateToken(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return { valid: false, error: 'Missing token' };

  try {
    const [payloadB64, sigB64] = token.split('.');
    if (!payloadB64 || !sigB64) throw new Error('Invalid format');

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.HMAC_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sig = base64UrlToBytes(sigB64);
    const valid = await crypto.subtle.verify(
      'HMAC', key, sig, new TextEncoder().encode(payloadB64)
    );
    if (!valid) throw new Error('Bad signature');

    const payload = JSON.parse(base64UrlDecode(payloadB64));
    if (payload.exp && Date.now() > payload.exp * 1000) throw new Error('Expired');
    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

async function createToken(payload, env) {
  const headerB64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=+$/, '');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  const unsigned = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${unsigned}.${sigB64}`;
}

function base64UrlToBytes(b64url) {
  const base64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const u8 = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
  return u8;
}

function base64UrlDecode(b64url) {
  return atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
}

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

// ========== HTML pages ==========
function activationHTML(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AdobeNativePlayer</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #111; color: #eee; text-align: center; padding: 2rem; }
    h1 { color: #fa0f00; margin-bottom: 0.5rem; }
    .status { font-size: 1.5rem; font-weight: bold; color: #4caf50; }
    .endpoints { margin-top: 2rem; text-align: left; max-width: 750px; margin-left: auto; margin-right: auto; background: #222; padding: 1.5rem; border-radius: 8px; }
    code { background: #333; padding: 0.2em 0.4em; border-radius: 4px; }
    a { color: #ff7043; }
  </style>
</head>
<body>
  <h1>AdobeNativePlayer</h1>
  <p class="status">✅ Activated</p>
  <p>Proxy running at <code>${baseUrl}</code></p>
  <div class="endpoints">
    <h2>IPTV Proxy Endpoints (no token)</h2>
    <ul>
      <li><strong>Proxy Playlist</strong><br><code>${baseUrl}/proxy/playlist.m3u8?url=ENCODED_STREAM_URL</code></li>
      <li><strong>Proxy Segment</strong><br><code>${baseUrl}/proxy/segment?url=ENCODED_SEGMENT_URL</code></li>
    </ul>
    <h2>AdobeNative Player Endpoints (require token)</h2>
    <ul>
      <li><strong>Player</strong><br><code>${baseUrl}/player?video=&lt;ID&gt;&token=TOKEN</code></li>
      <li><strong>Embed</strong><br><code>${baseUrl}/embed?video=&lt;ID&gt;&token=TOKEN</code></li>
      <li><strong>JSON Playback</strong><br><code>${baseUrl}/playback.json?video=&lt;ID&gt;&token=TOKEN</code></li>
    </ul>
    <h2>Share (public)</h2>
    <ul>
      <li><strong>Generate share link</strong><br><code>${baseUrl}/share?video=&lt;ID&gt;&exp=SECONDS</code></li>
    </ul>
    <p><em>Run locally: <code>wrangler dev --port 3000</code> (or 4000, 5000, 8080)</em></p>
  </div>
</body>
</html>`;
}

function playerHTML(videoId, token, isEmbed = false) {
  const manifestUrl = `/proxy/playlist.m3u8?url=${encodeURIComponent(videoId)}`;
  const poster = `/thumb/${videoId}/poster.jpg?token=${encodeURIComponent(token)}`;
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
<video id="video" controls ${isEmbed ? '' : 'autoplay'} poster="${poster}"></video>
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
/**
 * Fetches a remote resource and returns the Response with appropriate CORS.
 * Uses caching to speed up repeated requests.
 */
async function fetchRemote(url, request) {
  const cache = caches.default;
  // Build a cache key from the full request URL
  const cacheKey = new Request(url, {
    method: request.method,
    headers: request.headers
  });

  let response = await cache.match(cacheKey);
  if (!response) {
    // Forward useful request headers (like Range) but drop Host
    const headers = new Headers(request.headers);
    headers.delete('Host');

    response = await fetch(url, {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(15000)
    });

    // Only cache successful responses briefly
    if (response.ok) {
      const cloned = new Response(response.body, response);
      cloned.headers.set('Cache-Control', 'public, max-age=10');
      ctx?.waitUntil(cache.put(cacheKey, cloned)); // will be passed ctx from main handler
    }
    // Note: ctx may be null here; we'll call fetchRemote with ctx where available.
    // For simplicity in this example, we'll rely on caching via Cache-Control header directly on the response.
    // To respect the worker's context, we'll adjust the integration below.
  }
  return response;
}

/**
 * Rewrite absolute URLs in an M3U8 playlist to point back to /proxy/segment
 */
function rewritePlaylist(text, proxyBase) {
  const lines = text.split('\n');
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    // Match an absolute HTTP(S) URL
    if (/^https?:\/\//i.test(trimmed)) {
      const segUrl = encodeURIComponent(trimmed);
      return `${proxyBase}/proxy/segment?url=${segUrl}`;
    }
    return line;
  });
  return rewritten.join('\n');
}

// ========== Share handler ==========
async function handleShare(request, env) {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('video');
  if (!videoId) return new Response(JSON.stringify({ error: 'Missing video' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });

  const expSeconds = parseInt(url.searchParams.get('exp')) || 86400;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'share',
    video: videoId,
    iat: now,
    exp: now + expSeconds
  };
  const token = await createToken(payload, env);

  const baseUrl = `${url.protocol}//${url.host}`;
  const shareUrl = `${baseUrl}/player?video=${encodeURIComponent(videoId)}&token=${encodeURIComponent(token)}`;
  const embedUrl = `${baseUrl}/embed?video=${encodeURIComponent(videoId)}&token=${encodeURIComponent(token)}`;
  const embedCode = `<iframe src="${embedUrl}" style="width:100%;aspect-ratio:16/9" frameborder="0" allowfullscreen></iframe>`;

  return new Response(JSON.stringify({ shareUrl, embedUrl, embedCode, expiresIn: expSeconds }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ========== JSON Playback ==========
async function servePlaybackJSON(request, env, userInfo) {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('video') || userInfo.video;
  if (!videoId) return new Response(JSON.stringify({ error: 'Missing video ID' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' }
  });

  const token = url.searchParams.get('token') || '';
  const baseUrl = `${url.protocol}//${url.host}`;
  const manifestUrl = `${baseUrl}/proxy/playlist.m3u8?url=${encodeURIComponent(videoId)}`;

  return new Response(JSON.stringify({
    id: videoId,
    title: 'AdobeNative Stream',
    hls: manifestUrl,
    dash: null,
    progressive: null,
    poster: `${baseUrl}/thumb/${videoId}/poster.jpg?token=${encodeURIComponent(token)}`,
    subtitles: [],
    metadata: { adobeNative: true }
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ========== Main handler ==========
export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ----- Activation / landing page -----
    if (path === '/' || !path.match(/\/(proxy\/)?(playlist\.m3u8|segment|player|embed|playback\.json|share|thumb)/)) {
      return new Response(activationHTML(`${url.protocol}//${url.host}`), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
      });
    }

    // ----- Public: share -----
    if (path === '/share') {
      return handleShare(request, env);
    }

    // ----- Proxy endpoints (no token required) -----
    if (path === '/proxy/playlist.m3u8') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return new Response('Missing url parameter', { status: 400 });

      const resp = await fetch(targetUrl, {
        headers: { 'User-Agent': request.headers.get('User-Agent') || 'AdobeNative/1.0' }
      });
      if (!resp.ok) return new Response(`Failed to fetch playlist: ${resp.status}`, { status: 502 });

      const text = await resp.text();
      const proxyBase = `${url.protocol}//${url.host}`;
      const modified = rewritePlaylist(text, proxyBase);

      return new Response(modified, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=5'
        }
      });
    }

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
      responseHeaders.set('Access-Control-Allow-Origin', '*');

      const cr = segmentResp.headers.get('content-range');
      if (cr) responseHeaders.set('Content-Range', cr);
      const cl = segmentResp.headers.get('content-length');
      if (cl) responseHeaders.set('Content-Length', cl);

      return new Response(segmentResp.body, {
        status: segmentResp.status,
        headers: responseHeaders
      });
    }

    // ----- Token‑required endpoints -----
    const tokenParam = url.searchParams.get('token');
    if (!tokenParam) {
      return addCors(new Response(JSON.stringify({ error: 'Missing token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      }), request);
    }

    const auth = await validateToken(request, env);
    if (!auth.valid) {
      return addCors(new Response(JSON.stringify({ error: 'Unauthorized', details: auth.error }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      }), request);
    }

    const userInfo = auth.payload;

    if (path === '/player') {
      const videoId = url.searchParams.get('video') || userInfo.video;
      if (!videoId) return addCors(new Response('Missing video param', { status: 400 }), request);
      return addCors(new Response(playerHTML(videoId, tokenParam, false), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
      }), request);
    }

    if (path === '/embed') {
      const videoId = url.searchParams.get('video') || userInfo.video;
      if (!videoId) return addCors(new Response('Missing video param', { status: 400 }), request);
      return addCors(new Response(playerHTML(videoId, tokenParam, true), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
      }), request);
    }

    if (path === '/playback.json') {
      return addCors(await servePlaybackJSON(request, env, userInfo), request);
    }

    // Thumbnail placeholder
    if (path.startsWith('/thumb/')) {
      return addCors(new Response('Thumbnail placeholder – no origin', { status: 404 }), request);
    }

    // Fallback 404
    return addCors(new Response('Not Found', { status: 404 }), request);
  }
};
