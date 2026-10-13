/**
 * PHASE 17.6 — deterministic multi-step local browser fixture.
 *
 * A real shopping flow that requires THREE genuine browser transitions and
 * cannot be completed in one step:
 *
 *   /                      home
 *   /catalog               product list        (link click → real navigation)
 *   /product/alpha-widget  product detail      (link click → real navigation)
 *   /cart?item=…&qty=…     cart                (form GET submit → real navigation)
 *
 * DESIGN CONSTRAINTS (17.6E)
 * ───────────────────────────
 * 1. No scripted action proposer lives here. This file serves HTML and nothing
 *    else; the agent must decide every transition.
 * 2. The product-detail URL is NOT discoverable from the home page. The only
 *    route to it is through /catalog, so a single guessed `navigate` cannot
 *    reach the goal. Discovery is required, not memorisation.
 * 3. Every page exposes EXPLICIT observable markers via `data-marker`, so Goal
 *    Verification can prove completion from the live DOM rather than from the
 *    sequence of actions the agent happened to dispatch.
 * 4. The cart is server-rendered from the query string, so the browser
 *    genuinely produces the cart URL. Nothing is injected into page state by
 *    the harness.
 */

import http from 'http';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
 body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.5}
 nav a{margin-right:1rem}
 .card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}
 .price{font-weight:600}
</style></head>
<body>
<nav>
  <a id="nav-home" href="/">Home</a>
  <a id="nav-catalog" href="/catalog">Catalog</a>
  <a id="nav-cart" href="/cart">Cart</a>
</nav>
${body}
</body></html>`;

/* ── / ─────────────────────────────────────────────────────────────────────── */
const HOME = page(
  'Fixture Store',
  `<h1 id="home-heading">Fixture Store</h1>
<p id="home-marker" data-marker="home">WELCOME TO THE FIXTURE STORE</p>
<p>Browse the catalog to find a product.</p>
<a id="browse-catalog" href="/catalog">Browse catalog</a>`
);

/* ── /catalog ─────────────────────────────────────────────────────────────── */
const CATALOG = page(
  'Fixture Store — Catalog',
  `<h1 id="catalog-heading">Catalog</h1>
<p id="catalog-marker" data-marker="catalog">CATALOG</p>

<section class="card" id="card-alpha-widget">
  <h2 id="alpha-widget-title">Alpha Widget</h2>
  <p class="price" id="alpha-widget-price">Price: 24</p>
  <a id="alpha-widget-link" href="/product/alpha-widget">View Alpha Widget</a>
</section>

<section class="card" id="card-beta-gizmo">
  <h2 id="beta-gizmo-title">Beta Gizmo</h2>
  <p class="price" id="beta-gizmo-price">Price: 58</p>
  <a id="beta-gizmo-link" href="/product/beta-gizmo">View Beta Gizmo</a>
</section>`
);

/* ── /product/:slug ───────────────────────────────────────────────────────── */
function productPage(slug) {
  const known = {
    'alpha-widget': { name: 'Alpha Widget', price: 24, sku: 'AW-24' },
    'beta-gizmo': { name: 'Beta Gizmo', price: 58, sku: 'BG-58' },
  }[slug];
  if (!known) return null;
  return page(
    `${known.name} — Fixture Store`,
    `<h1 id="product-heading">${esc(known.name)}</h1>
<p id="product-marker" data-marker="product-detail">PRODUCT DETAIL</p>
<p class="price" id="product-alpha-widget-price-24" data-sku="${esc(known.sku)}">
  Price: ${known.price}
</p>
<form id="cart-form" action="/cart" method="get">
  <label for="qty">Quantity</label>
  <select id="qty" name="qty">
    <option value="1">1</option>
    <option value="2">2</option>
    <option value="3">3</option>
  </select>
  <input type="hidden" id="item" name="item" value="${esc(slug)}">
  <button id="add-to-cart" type="submit">Add to cart</button>
</form>
<a id="back-to-catalog" href="/catalog">Back to catalog</a>`
  );
}

/* ── /cart ────────────────────────────────────────────────────────────────── */
function cartPage(item, qty) {
  const known = {
    'alpha-widget': 'Alpha Widget',
    'beta-gizmo': 'Beta Gizmo',
  }[String(item ?? '')];
  const name = known ?? 'nothing';
  const count = /^\d{1,2}$/.test(String(qty ?? '')) ? Number(qty) : 0;
  return page(
    'Fixture Store — Cart',
    `<h1 id="cart-heading">Cart</h1>
<p id="cart-marker" data-marker="cart">CART</p>
<p id="cart-contents" data-item="${esc(String(item ?? ''))}" data-qty="${String(count)}">
  Cart contains: ${esc(name)} (quantity ${count})
</p>
<a id="continue-shopping" href="/catalog">Continue shopping</a>`
  );
}

const ROUTES = {
  '/': () => HOME,
  '/catalog': () => CATALOG,
  '/product/alpha-widget': () => productPage('alpha-widget'),
  '/product/beta-gizmo': () => productPage('beta-gizmo'),
  '/cart': (u) => cartPage(u.searchParams.get('item'), u.searchParams.get('qty')),
};

/**
 * Serves the Phase 17.6 fixture. Resolves with the http.Server.
 * A missing product path returns a real 404 rather than a redirect, so a
 * hallucinated product name cannot be silently satisfied.
 */
export function servePhase176Fixture(port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${port}`);
    const route = ROUTES[u.pathname];
    if (route) {
      const html = route(u);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(
      page('Not Found', `<h1 id="notfound-heading">404</h1><p id="notfound-marker" data-marker="not-found">NOT FOUND</p>`)
    );
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server)));
}

export const PHASE176_ROUTES = Object.keys(ROUTES);
