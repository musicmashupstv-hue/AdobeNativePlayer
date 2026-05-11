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

function base64UrlToBytes(b64url) { /* … same … */ }
function base64UrlDecode(b64url) { /* … same … */ }

// ========== CORS ==========
function corsHeaders(request) { /* … same … */ }
function addCors(response, request) { /* … same … */ }

// ========== HTML pages ==========
function activationHTML(baseUrl) { /* … same … */ }
function playerHTML(videoId, token, isEmbed = false) { /* … same … */ }

// ========== Proxy helpers ==========
/**
 * Fetches a remote resource and returns the Response with appropriate CORS.
 * Uses caching to speed up repeated requests.
 */
async function fetchRemote(url, request) {
  const cache = caches.default;
  let response = await cache.match(request);
  if (!response) {
    // Forward request headers (like Range) for partial content support
    const headers = new Headers(request.headers);
    // Avoid passing the Host header from the original request
    headers.delete('Host');
    response = await fetch(url, {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(15000)
    });
    // Only cache successful responses for a short time
    if (response.ok) {
      const cloned = new Response(response.body, response);
      cloned.headers.set('Cache-Control', 'public, max-age=10');
      await cache.put(request, cloned);
    }
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
async function handleShare(request, env) { /* … same … */ }

// ========== JSON Playback ==========
async function servePlaybackJSON(request, env, userInfo) { /* … same … */ }

// ========== Main handler ==========
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ----- No‑auth endpoints -----
    if (path === '/' || (!path.match(/\.(m3u8|mpd|ts|m4s|mp4|jpg|png|json)$/) && path !== '/share' && path !== '/player' && path !== '/embed' && path !== '/playback.json' && path !== '/proxy/playlist.m3u8' && path !== '/proxy/segment')) {
      const baseUrl = `${url.protocol}//${url.host}`;
      return new Response(activationHTML(baseUrl), {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
      });
    }

    if (path === '/share') {
      return handleShare(request, env);
    }

    // ----- Proxy endpoints (no token required – they are called by the player) -----
    if (path === '/proxy/playlist.m3u8') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return new Response('Missing url parameter', { status: 400 });

      // Fetch the remote M3U8
      const remoteResponse = await fetchRemote(targetUrl, request);
      if (!remoteResponse.ok) return new Response('Failed to fetch playlist', { status: 502 });

      const text = await remoteResponse.text();
      // Build the proxy base URL for segment rewriting
      const proxyBase = `${url.protocol}//${url.host}`;
      const modified = rewritePlaylist(text, proxyBase);

      return new Response(modified, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        }
      });
    }

    if (path === '/proxy/segment') {
      const segUrl = url.searchParams.get('url');
      if (!segUrl) return new Response('Missing url parameter', { status: 400 });

      const remoteResponse = await fetchRemote(segUrl, request);
      // Pass through all headers (especially Content-Type, Content-Length, etc.)
      const headers = new Headers(remoteResponse.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'public, max-age=10');

      return new Response(remoteResponse.body, {
        status: remoteResponse.status,
        statusText: remoteResponse.statusText,
        headers
      });
    }

    // ----- Auth‑required endpoints -----
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

    if (path === '/playback.json') {
      const resp = await servePlaybackJSON(request, env, userInfo);
      return addCors(resp, request);
    }

    // Placeholder media responses (no origin yet)
    if (path.match(/\.(mp4|ts|m4s)$/)) {
      return addCors(new Response('No origin configured – segment unavailable', { status: 404 }), request);
    }

    if (path.match(/\.(m3u8|mpd)$/)) {
      return addCors(
        new Response('#EXTM3U\n#EXT-X-ENDLIST', {
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
        }),
        request
      );
    }

    if (path.startsWith('/thumb/')) {
      return addCors(new Response('Thumbnail placeholder – no origin', { status: 404 }), request);
    }

    return addCors(new Response('AdobeNative Player Proxy', { status: 200 }), request);
  }
};
