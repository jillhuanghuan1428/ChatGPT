const gameHtml = __GAME_HTML__;
const pageHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/leaderboard' || url.pathname.startsWith('/api/leaderboard/')) {
      const response = await handleLeaderboard(request, env);
      if (response) return response;
    }
    if (url.pathname === '/api/rooms' || url.pathname.startsWith('/api/rooms/')) {
      const response = await handleRooms(request, env);
      if (response) return response;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!['GET', 'HEAD'].includes(request.method)) {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      return new Response(request.method === 'HEAD' ? null : gameHtml, { headers: pageHeaders });
    }
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    return new Response('Not found', { status: 404 });
  },
};
