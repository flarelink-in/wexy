// Public HTML/SEO only. No user identity, model calls, GPU imports or request-derived origins.
export const SITES = Object.freeze({
    dev: Object.freeze({ origin: 'https://dev.wexy.ai', indexable: false }),
    prod: Object.freeze({ origin: 'https://wexy.ai', indexable: true }),
});

const DESCRIPTION = 'Describe a world. Fly through it. Share the film. Wexy renders 3D worlds on your own computer.';
export const SECURITY_HEADERS = Object.freeze({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
});

export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
}

export function renderHome(template, site) {
    if (!template.includes('</head>') || !template.includes('</body>')) {
        throw new Error('Public HTML template is incomplete; run the matching frontend build.');
    }
    // Replace rather than duplicate the static page's metadata. Body and Vite asset URLs stay byte-identical.
    const head = template.slice(0, template.indexOf('</head>'))
        .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
        .replace(/<meta\b(?=[^>]*(?:name|property)\s*=\s*["'](?:description|robots|og:[^"']*|twitter:[^"']*)["'])[^>]*>/gi, '')
        .replace(/<link\b(?=[^>]*rel\s*=\s*["']canonical["'])[^>]*>/gi, '');
    const url = `${site.origin}/`;
    const image = `${site.origin}/icon-full.png`;
    return `${head}
    <title>Wexy Studio</title>
    <meta name="description" content="${escapeHtml(DESCRIPTION)}">
    <meta name="robots" content="${site.indexable ? 'index, follow' : 'noindex, nofollow'}">
    <link rel="canonical" href="${escapeHtml(url)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Wexy">
    <meta property="og:title" content="Wexy Studio">
    <meta property="og:description" content="${escapeHtml(DESCRIPTION)}">
    <meta property="og:url" content="${escapeHtml(url)}">
    <meta property="og:image" content="${escapeHtml(image)}">
    <meta property="og:image:alt" content="A black hole rendered with Wexy">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="Wexy Studio">
    <meta name="twitter:description" content="${escapeHtml(DESCRIPTION)}">
    <meta name="twitter:image" content="${escapeHtml(image)}">
${template.slice(template.indexOf('</head>'))}`;
}

/** Same response for humans and crawlers. Query strings never enter the document or its canonical URL. */
export function publicResponse({ method, url }, site, loadTemplate) {
    const headers = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' };
    if (!site.indexable) headers['X-Robots-Tag'] = 'noindex, nofollow';
    if (!['GET', 'HEAD'].includes(method)) {
        return { status: 405, headers: { ...headers, Allow: 'GET, HEAD' }, body: 'Method not allowed' };
    }
    const path = url.split('?', 1)[0];
    let body;
    if (path === '/') {
        headers['Content-Type'] = 'text/html; charset=utf-8';
        body = renderHome(loadTemplate(), site);
    } else if (path === '/robots.txt') {
        headers['Content-Type'] = 'text/plain; charset=utf-8';
        body = site.indexable
            ? `User-agent: *\nAllow: /\nDisallow: /studio\nDisallow: /studio.html\nSitemap: ${site.origin}/sitemap.xml\n`
            : 'User-agent: *\nDisallow: /\n';
    } else if (path === '/sitemap.xml') {
        headers['Content-Type'] = 'application/xml; charset=utf-8';
        body = '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            + (site.indexable ? `<url><loc>${escapeHtml(site.origin)}/</loc></url>` : '') + '</urlset>\n';
    } else {
        return { status: 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' };
    }
    return { status: 200, headers, body: method === 'HEAD' ? '' : body };
}
