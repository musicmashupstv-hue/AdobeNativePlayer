/**
 * AdobeNative — Self‑contained Player Activation Proxy
 *
 * No AI binding, no external origin.
 * Root path returns an HTML page saying "AdobeNativePlayer Activated"
 * and lists all available endpoints based on the current host.
 *
 * Endpoints:
 *   /player?video=<id>&token=<jwt>     → HTML5 player page (HLS.js)
 *   /embed?video=<id>&token=<jwt>      → Minimal iframe‑ready player
 *   /share?video=<id>&exp=<seconds>     → Generate shareable URLs (public)
 *   /thumb/<…>                         → Placeholder thumbnail endpoint
 *   *.m3u8 / *.mpd                     → Enhanced manifests (no origin, dummy)
 *   *.ts / *.m4s                       → Video segments (no origin, 404)
 *   *.mp4                              → Direct MP4 (no origin, 404)
 *
 * Security: All media endpoints still require a valid HMAC‑signed token.
 *           Without an origin, they return 404 unless configured otherwise.
 */

// ── Auth helpers ──────────────────────────────────────────────
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
  const headerB64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '');
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

// ── CORS helper ───────────────────────────────────────────────
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

// ── HTML pages ───────────────────────────────────────────────
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
    .endpoints { margin-top: 2rem; text-align: left; max-width: 700px; margin-left: auto; margin-right: auto; background: #222; padding: 1.5rem; border-radius: 8px; }
    code { background: #333; padding: 0.2em 0.4em; border-radius: 4px; }
    a { color: #ff7043; }
  </style>
</head>
<body>
  <h1>AdobeNativePlayer</h1>
  <p class="status">✅ Activated</p>
  <p>Proxy running at <code>${baseUrl}</code></p>

  <div class="endpoints">
    <h2>Available Endpoints</h2>
    <ul>
      <li><strong>Player</strong><br><code>${baseUrl}/player?video=&lt;ID&gt;&token=&lt;TOKEN&gt;</code></li>
      <li><strong>Embed</strong><br><code>${baseUrl}/embed?video=&lt;ID&gt;&token=&lt;TOKEN&gt;</code></li>
      <li><strong>Share</strong> (public)<br><code>${baseUrl}/share?video=&lt;ID&gt;&exp=&lt;SECONDS&gt;</code></li>
      <li><strong>Manifest</strong><br><code>${baseUrl}/&lt;VIDEO&gt;/master.m3u8?token=&lt;TOKEN&gt;</code></li>
      <li><strong>Segment</strong><br><code>${baseUrl}/&lt;PATH&gt;.ts?token=&lt;TOKEN&gt;</code></li>
      <li><strong>MP4 direct</strong><br><code>${baseUrl}/&lt;PATH&gt;.mp4?token=&lt;TOKEN&gt;</code></li>
      <li><strong>Thumbnail</strong><br><code>${baseUrl}/thumb/&lt;PATH&gt;?token=&lt;TOKEN&gt;</code></li>
    </ul>
    <p><em>Note: Media endpoints require a valid JWT token. Without an origin backend, actual video playback will fail unless configured.</em></p>
  </div>
</body>
</html>`;
}

function playerHTML(videoId, token, isEmbed = false) {
  const manifestUrl = `/${videoId}/master.m3u8?token=${encodeURIComponent(token)}`;
  const poster = `/thumb/${videoId}/poster.jpg?token=${encodeURIComponent(token)}`;
  const extraStyle = isEmbed
    ? 'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}video{width:100%;height:100%;object-fit:contain}'
    : 'body{font-family:system-ui;background:#000;color:#fff;text-align:center}video{max-width:100%;max-height:80vh}';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isEmbed ? 'AdobeNative Embed' : 'AdobeNative Player'}</title>
  <style>${extraStyle}</style>
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

// ── Share handler ─────────────────────────────────────────────
async function handleShare(request, env) {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('video');
  if (!videoId) return new Response(JSON.stringify({ error: 'Missing video' }), {
    status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
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

  const base = `${url.protocol}//${url.host}`;
  const shareUrl = `${base}/player?video=${encodeURIComponent(videoId)}&token=${encodeURIComponent(token)}`;
  const embedUrl = `${base}/embed?video=${encodeURIComponent(videoId)}&token=${encodeURIComponent(token)}`;
  const embedCode = `<iframe src="${embedUrl}" style="width:100%;aspect-ratio:16/9" frameborder="0" allowfullscreen></iframe>`;

  return new Response(JSON.stringify({ shareUrl, embedUrl, embedCode, expiresIn: expSeconds }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ── Main handler ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Root (or any unrecognized path) → Activation page
    if (path === '/' || !path.match(/\.(m3u8|mpd|ts|m4s|mp4|jpg|png)/) && path !== '/share' && path !== '/player' && path !== '/embed') {
      const baseUrl = `${url.protocol}//${url.host}`;
      return new Response(activationHTML(baseUrl), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
      });
    }

    // Public share endpoint
    if (path === '/share') {
      return handleShare(request, env);
    }

    // All other endpoints require token
    const tokenParam = url.searchParams.get('token');
    if (!tokenParam) {
      return addCors(
        new Response(JSON.stringify({ error: 'Missing token' }), {
          status: 401, headers: { 'Content-Type': 'application/json' }
        }), request
      );
    }

    const auth = await validateToken(request, env);
    if (!auth.valid) {
      return addCors(
        new Response(JSON.stringify({ error: 'Unauthorized', details: auth.error }), {
          status: 401, headers: { 'Content-Type': 'application/json' }
        }), request
      );
    }

    // Player / Embed pages
    if (path === '/player') {
      const videoId = url.searchParams.get('video');
      if (!videoId) return addCors(new Response('Missing video param', { status: 400 }), request);
      return addCors(new Response(playerHTML(videoId, tokenParam, false), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
      }), request);
    }

    if (path === '/embed') {
      const videoId = url.searchParams.get('video');
      if (!videoId) return addCors(new Response('Missing video param', { status: 400 }), request);
      return addCors(new Response(playerHTML(videoId, tokenParam, true), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
      }), request);
    }

    // Placeholder media responses (no origin → 404 or dummy)
    if (path.match(/\.(mp4|ts|m4s)$/)) {
      return addCors(new Response('No origin configured – video segment unavailable', { status: 404 }), request);
    }

    if (path.match(/\.(m3u8|mpd)$/)) {
      return addCors(
        new Response('#EXTM3U\n#EXT-X-ENDLIST', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }),
        request
      );
    }

    if (path.startsWith('/thumb/')) {
      return addCors(new Response('Thumbnail placeholder – no origin', { status: 404 }), request);
    }

    // Catch-all
    return addCors(new Response('AdobeNative Player Proxy', { status: 200 }), request);
  }
};
