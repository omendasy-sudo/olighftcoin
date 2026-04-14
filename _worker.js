// Cloudflare Pages Function - force no-cache headers on all HTML/JS responses
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await env.ASSETS.fetch(request);
    
    // For HTML pages and sw.js, force no-cache
    const path = url.pathname;
    if (path.endsWith('.html') || path === '/' || path === '/sw.js') {
      const newResponse = new Response(response.body, response);
      newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      newResponse.headers.set('Pragma', 'no-cache');
      newResponse.headers.set('Expires', '0');
      newResponse.headers.set('CDN-Cache-Control', 'no-store');
      newResponse.headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
      return newResponse;
    }
    
    return response;
  }
};
