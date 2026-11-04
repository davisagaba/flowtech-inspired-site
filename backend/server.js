const express = require('express');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const ADMIN_PASSWORD = process.env.LSC_ADMIN_PASSWORD || 'change-me';
const ANALYTICS_LOG = '/opt/lifestyle-ceramics/backend/analytics.log';
const PUBLIC_DIR = '/opt/lifestyle-ceramics/public';
const PRODUCTS_JSON = '/opt/lifestyle-ceramics/backend/products.json';
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads', 'products');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Mail attachments are staged privately (not under the public web root) and
// deleted once the email that references them has been sent.
const MAIL_ATTACHMENTS_DIR = '/opt/lifestyle-ceramics/backend/mail-attachments';
if (!fs.existsSync(MAIL_ATTACHMENTS_DIR)) fs.mkdirSync(MAIL_ATTACHMENTS_DIR, { recursive: true });

// --- Document template settings (used by Quote/Invoice/Receipt PDFs) ---
const SETTINGS_JSON = '/opt/lifestyle-ceramics/backend/settings.json';
const DEFAULT_SETTINGS = {
  companyName: 'Life Style Ceramics',
  tagline: 'Sanitaryware, Urinals & Basins',
  accentColor: '#0d5559',
  footerTerms: 'Prices include 15% VAT and are subject to confirmation of stock availability.',
  bankDetails: '',
  vatNumber: '',
};
function loadSettings() {
  if (!fs.existsSync(SETTINGS_JSON)) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2));
}

const mailer = nodemailer.createTransport({
  host: process.env.LSC_SMTP_HOST || 'smtpout.secureserver.net',
  port: Number(process.env.LSC_SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.LSC_SMTP_USER,
    pass: process.env.LSC_SMTP_PASS,
  },
});

function imapClient() {
  return new ImapFlow({
    host: process.env.LSC_IMAP_HOST || 'imap.secureserver.net',
    port: Number(process.env.LSC_IMAP_PORT) || 993,
    secure: true,
    auth: {
      user: process.env.LSC_SMTP_USER,
      pass: process.env.LSC_SMTP_PASS,
    },
    logger: false,
  });
}

// Fetches the most recent messages from a mailbox folder, newest first.
async function fetchMailbox(folder, limit) {
  const client = imapClient();
  const messages = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const mailbox = client.mailbox;
      const total = mailbox.exists;
      if (total > 0) {
        const start = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(`${start}:${total}`, { envelope: true, flags: true, source: true })) {
          let snippet = '';
          let body = '';
          try {
            const parsed = await simpleParser(msg.source);
            body = (parsed.text || '').trim().slice(0, 5000);
            snippet = body.replace(/\s+/g, ' ').slice(0, 200);
          } catch {
            /* ignore parse failure, snippet/body stay empty */
          }
          messages.push({
            uid: msg.uid,
            from: msg.envelope.from && msg.envelope.from[0] ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address}>`.trim() : '',
            fromAddress: msg.envelope.from && msg.envelope.from[0] ? msg.envelope.from[0].address : '',
            to: msg.envelope.to && msg.envelope.to[0] ? msg.envelope.to[0].address : '',
            subject: msg.envelope.subject || '(no subject)',
            date: msg.envelope.date,
            seen: msg.flags.has('\\Seen'),
            messageId: msg.envelope.messageId || '',
            snippet,
            body,
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return messages.reverse();
}

// --- Admin users (named logins) ---
const USERS_JSON = '/opt/lifestyle-ceramics/backend/users.json';
function loadUsers() {
  if (!fs.existsSync(USERS_JSON)) {
    const seeded = [{ username: 'admin', password: ADMIN_PASSWORD, role: 'admin' }];
    fs.writeFileSync(USERS_JSON, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  try {
    return JSON.parse(fs.readFileSync(USERS_JSON, 'utf8'));
  } catch {
    return [{ username: 'admin', password: ADMIN_PASSWORD, role: 'admin' }];
  }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_JSON, JSON.stringify(users, null, 2));
}

// Accepts either {username, password} (named login) or just {password}
// (legacy/back-compat — matches against any user's password so existing
// bookmarked links and the original shared-password flow keep working).
function requireAdmin(req, res, next) {
  const pw = req.query.password || req.headers['x-admin-password'];
  const username = req.query.username || req.headers['x-admin-username'];
  const users = loadUsers();

  let matched = null;
  if (username) {
    matched = users.find((u) => u.username === username && u.password === pw);
  } else {
    matched = users.find((u) => u.password === pw);
  }

  if (!matched) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  req.adminUser = matched.username;
  next();
}

// --- Activity log (audit trail) ---
const ACTIVITY_LOG = '/opt/lifestyle-ceramics/backend/activity.log';
function logActivity(user, action, details) {
  fs.appendFile(ACTIVITY_LOG, JSON.stringify({
    user: user || 'admin', action, details: details || '', date: new Date().toISOString(),
  }) + '\n', () => {});
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// --- Visitor tracking ---
app.post('/track', (req, res) => {
  try {
    const { path: pagePath, referrer } = req.body || {};
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const entry = {
      path: String(pagePath || '').slice(0, 200),
      referrer: String(referrer || '').slice(0, 300),
      ip,
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
      ts: new Date().toISOString(),
    };
    fs.appendFile(ANALYTICS_LOG, JSON.stringify(entry) + '\n', () => {});
    res.status(204).end();
  } catch {
    res.status(204).end();
  }
});

// --- Admin dashboard data (password-protected) ---
app.get('/analytics', requireAdmin, (req, res) => {
  const views = readJsonLines(ANALYTICS_LOG);
  // A quote can appear twice (pending_review, then sent) — keep only the
  // latest entry per quoteNumber so the dashboard shows current status.
  const quotesByNumber = new Map();
  readJsonLines(LOG_PATH).forEach((q) => quotesByNumber.set(q.quoteNumber, q));
  const quotes = [...quotesByNumber.values()];

  const now = Date.now();
  const since = (days) => now - days * 24 * 60 * 60 * 1000;
  const viewsInWindow = (days) => views.filter((v) => new Date(v.ts).getTime() >= since(days));

  function summarize(list) {
    const byPath = {};
    const ips = new Set();
    list.forEach((v) => {
      byPath[v.path] = (byPath[v.path] || 0) + 1;
      if (v.ip) ips.add(v.ip);
    });
    const topPages = Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([pagePath, count]) => ({ path: pagePath, count }));
    return { totalViews: list.length, uniqueVisitors: ips.size, topPages };
  }

  res.json({
    ok: true,
    last24h: summarize(viewsInWindow(1)),
    last7d: summarize(viewsInWindow(7)),
    last30d: summarize(viewsInWindow(30)),
    allTime: summarize(views),
    recentViews: views.slice(-40).reverse(),
    quoteRequests: quotes.reverse(),
  });
});

// Generated quote PDFs are kept PRIVATE (not under /public) — they are for staff
// review and manual sending only, never auto-downloaded or linked to the client.
const QUOTES_DIR = '/opt/lifestyle-ceramics/backend/quotes-private';
if (!fs.existsSync(QUOTES_DIR)) fs.mkdirSync(QUOTES_DIR, { recursive: true });

const LOG_PATH = '/opt/lifestyle-ceramics/backend/quote-requests.log';

function nextQuoteNumber() {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `LSC-${stamp}-${rand}`;
}

function formatZAR(n) {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
}

app.post('/quote', (req, res) => {
  try {
    const { name, email, phone, company, timeline, message, items } = req.body || {};

    if (!name || !email || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Missing required fields (name, email, items).' });
    }

    const quoteNumber = nextQuoteNumber();
    const date = new Date();
    const grandTotal = items.reduce((sum, it) => sum + (Number(it.lineTotal) || 0), 0);

    // --- Generate PDF ---
    const filename = `quote-${quoteNumber}.pdf`;
    const filePath = path.join(QUOTES_DIR, filename);
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(20).fillColor('#0d5559').text('Life Style Ceramics', { continued: false });
    doc.fontSize(10).fillColor('#444').text('Quotation');
    doc.moveDown(1.5);

    doc.fontSize(10).fillColor('#000');
    doc.text(`Quote Number: ${quoteNumber}`);
    doc.text(`Date: ${date.toLocaleDateString('en-ZA')}`);
    doc.moveDown(1);

    doc.fontSize(11).fillColor('#000').text('Prepared for:', { underline: true });
    doc.fontSize(10).text(name);
    if (company) doc.text(company);
    doc.text(email);
    if (phone) doc.text(phone);
    doc.moveDown(1.5);

    // Table header
    const tableTop = doc.y;
    doc.fontSize(10).fillColor('#444');
    doc.text('Item', 50, tableTop, { width: 220 });
    doc.text('Code', 270, tableTop, { width: 90 });
    doc.text('Qty', 360, tableTop, { width: 40, align: 'right' });
    doc.text('Unit Price', 400, tableTop, { width: 80, align: 'right' });
    doc.text('Line Total', 480, tableTop, { width: 70, align: 'right' });
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).strokeColor('#ccc').stroke();

    let y = tableTop + 22;
    doc.fillColor('#000');
    items.forEach((it) => {
      doc.fontSize(9);
      doc.text(String(it.name || ''), 50, y, { width: 220 });
      doc.text(String(it.code || ''), 270, y, { width: 90 });
      doc.text(String(it.qty || 1), 360, y, { width: 40, align: 'right' });
      doc.text(formatZAR(Number(it.unitPrice) || 0), 400, y, { width: 80, align: 'right' });
      doc.text(formatZAR(Number(it.lineTotal) || 0), 480, y, { width: 70, align: 'right' });
      y += 20;
    });

    doc.moveTo(50, y + 5).lineTo(550, y + 5).strokeColor('#ccc').stroke();
    doc.fontSize(11).fillColor('#0d5559').text(`Total (incl. 15% VAT): ${formatZAR(grandTotal)}`, 50, y + 15, { width: 500, align: 'right' });

    if (timeline || message) {
      doc.moveDown(3);
      doc.fontSize(10).fillColor('#000');
      if (timeline) doc.text(`Timeline: ${timeline}`);
      if (message) doc.text(`Notes: ${message}`);
    }

    doc.moveDown(2);
    doc.fontSize(8).fillColor('#888').text(
      'This quotation is valid for 30 days from the date above. Prices include 15% VAT and are subject to confirmation of stock availability.',
      { width: 500 }
    );

    doc.end();

    stream.on('finish', () => {
      // Log the request + where its PDF lives on disk, for staff to review and
      // forward manually (stand-in for auto-emailing until SMTP is configured).
      const logLine = JSON.stringify({
        quoteNumber, name, email, phone, company, timeline, message, items, grandTotal, date,
        status: 'pending_review',
        stage: 'requested',
        pdfPath: filePath,
      }) + '\n';
      fs.appendFile(LOG_PATH, logLine, () => {});

      // Client only gets confirmation that the request was received — no PDF
      // link. The quote is forwarded by a team member after review.
      res.json({
        ok: true,
        quoteNumber,
      });
    });

    stream.on('error', (err) => {
      console.error('PDF write error:', err);
      res.status(500).json({ ok: false, error: 'Could not generate PDF.' });
    });
  } catch (err) {
    console.error('Quote endpoint error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// --- Quote pipeline (per-client workflow tracking) ---
// Append-only log: /analytics and /admin/clients both dedupe by taking the
// LAST entry per quoteNumber, so a patch here is simply a new line with the
// previous entry's fields plus whatever changed.
const QUOTE_STAGES = ['requested', 'stock_confirmed', 'quote_sent', 'invoice_sent', 'paid'];
function getLatestQuote(quoteNumber) {
  const requests = readJsonLines(LOG_PATH);
  return [...requests].reverse().find((q) => q.quoteNumber === quoteNumber);
}
function appendQuoteUpdate(quoteNumber, patch) {
  const quote = getLatestQuote(quoteNumber);
  if (!quote) return null;
  const updated = { ...quote, ...patch };
  fs.appendFile(LOG_PATH, JSON.stringify(updated) + '\n', () => {});
  return updated;
}

app.put('/admin/quotes/:quoteNumber/stage', requireAdmin, (req, res) => {
  const { stage } = req.body || {};
  if (!QUOTE_STAGES.includes(stage)) {
    return res.status(400).json({ ok: false, error: 'Invalid stage. Must be one of: ' + QUOTE_STAGES.join(', ') });
  }
  const updated = appendQuoteUpdate(req.params.quoteNumber, { stage, [`${stage}At`]: new Date().toISOString() });
  if (!updated) return res.status(404).json({ ok: false, error: 'Quote not found.' });
  logActivity(req.adminUser, 'moved_quote_stage', `${req.params.quoteNumber} -> ${stage}`);
  res.json({ ok: true, quote: updated });
});

// Staff-triggered send: emails the already-generated, reviewed PDF to the
// client. Nothing is emailed automatically when a quote request comes in.
app.post('/admin/send-quote', requireAdmin, async (req, res) => {
  try {
    const { quoteNumber } = req.body || {};
    if (!quoteNumber) {
      return res.status(400).json({ ok: false, error: 'Missing quoteNumber.' });
    }

    const requests = readJsonLines(LOG_PATH);
    const quote = [...requests].reverse().find((q) => q.quoteNumber === quoteNumber);
    if (!quote) {
      return res.status(404).json({ ok: false, error: 'Quote not found.' });
    }
    if (!fs.existsSync(quote.pdfPath)) {
      return res.status(404).json({ ok: false, error: 'Quote PDF not found on disk.' });
    }

    await mailer.sendMail({
      from: `"Life Style Ceramics" <${process.env.LSC_SMTP_USER}>`,
      to: quote.email,
      subject: `Your Quotation ${quote.quoteNumber} — Life Style Ceramics`,
      text: `Hi ${quote.name},\n\nThank you for your interest. Please find your itemised quotation attached (${quote.quoteNumber}).\n\nThis quotation is valid for 30 days.\n\nKind regards,\nLife Style Ceramics`,
      attachments: [{ filename: path.basename(quote.pdfPath), path: quote.pdfPath }],
    });

    // Append a status-update log line; /analytics reads the latest entry per
    // quoteNumber last, so this marks it sent without rewriting the log.
    appendQuoteUpdate(quoteNumber, { status: 'sent', stage: 'quote_sent', sentAt: new Date().toISOString() });

    logActivity(req.adminUser, 'sent_quote', quoteNumber);
    res.json({ ok: true });
  } catch (err) {
    console.error('Send-quote error:', err);
    res.status(500).json({ ok: false, error: 'Could not send email.' });
  }
});

// --- Product catalog management (admin) ---
function loadProducts() {
  if (!fs.existsSync(PRODUCTS_JSON)) return [];
  try {
    return JSON.parse(fs.readFileSync(PRODUCTS_JSON, 'utf8'));
  } catch {
    return [];
  }
}

function saveProducts(products) {
  fs.writeFileSync(PRODUCTS_JSON, JSON.stringify(products, null, 2));
  regenerateCatalogJs(products);
  regenerateSitemap(products);
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Rewrites public/catalog.js from products.json so the storefront picks up
// admin changes immediately, with no redeploy. Helper functions below the
// data array are static and don't depend on product content.
function regenerateCatalogJs(products) {
  const dataBlock = JSON.stringify(products, null, 2);
  const out = `// Shared product catalog data for the washroom automation concept site.
// Auto-generated by the admin panel — do not hand-edit, changes will be overwritten.

const CATALOG = ${dataBlock};

const GBP_TO_ZAR_RATE = 24;
const VAT_RATE = 0.15;
const zarFormatter = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" });

function formatPrice(basePrice) {
  return zarFormatter.format(basePrice * GBP_TO_ZAR_RATE * (1 + VAT_RATE));
}

function formatPriceWithStrike(basePrice) {
  const original = basePrice * 1.18;
  return \`<span class="price-from">From</span> <strong>\${formatPrice(basePrice)}</strong> <del class="price-strike">\${formatPrice(original)}</del>\`;
}

function pexelsUrl(id, ext, w) {
  ext = ext || "jpeg";
  w = w || 500;
  return \`https://images.pexels.com/photos/\${id}/pexels-photo-\${id}.\${ext}?auto=compress&cs=tinysrgb&w=\${w}\`;
}

function getProductImages(product, w) {
  return product.images.map((img) => {
    if (typeof img === "string" && (img.startsWith("http") || img.startsWith("/uploads/"))) return img;
    return pexelsUrl(img, product.ext, w);
  });
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

CATALOG.forEach((p) => { p.slug = slugify(p.name); });

function getProductById(id) {
  return CATALOG.find((p) => p.id === Number(id));
}

function getProductBySlug(slug) {
  return CATALOG.find((p) => p.slug === slug);
}

function getProductByParam(params) {
  const slug = params.get("slug");
  if (slug) {
    const bySlug = getProductBySlug(slug);
    if (bySlug) return bySlug;
  }
  const id = params.get("id");
  if (id) return getProductById(id);
  return undefined;
}

function productUrl(product) {
  return "product-detail.html?slug=" + product.slug;
}

function getCategorySlug(category) {
  const map = {
    "Hand Dryers": "handdryers", "Automatic Taps": "taps", "Soap Dispensers": "dispensers",
    "Sensor Flushers": "sensors", "Entrance Automation": "entrance", "Accessories": "accessories"
  };
  return map[category] || "";
}
`;
  fs.writeFileSync(path.join(PUBLIC_DIR, 'catalog.js'), out);
}

function regenerateSitemap(products) {
  const staticUrls = [
    ['', '1.0'], ['products.html', '0.9'], ['ideas.html', '0.6'],
    ['services.html', '0.6'], ['professionals.html', '0.6'], ['about.html', '0.5'], ['quote.html', '0.7'],
  ];
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  staticUrls.forEach(([p, pr]) => lines.push(`  <url><loc>https://lyfestyleceramics.co.za/${p}</loc><priority>${pr}</priority></url>`));
  products.forEach((p) => lines.push(`  <url><loc>https://lyfestyleceramics.co.za/product-detail.html?slug=${slugify(p.name)}</loc><priority>0.8</priority></url>`));
  lines.push('</urlset>');
  fs.writeFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), lines.join('\n') + '\n');
}

// Seed products.json from the bundled seed file, once, if it doesn't exist yet.
if (!fs.existsSync(PRODUCTS_JSON)) {
  const seedPath = path.join(__dirname, 'products-seed.json');
  const seed = fs.existsSync(seedPath) ? JSON.parse(fs.readFileSync(seedPath, 'utf8')) : [];
  saveProducts(seed);
}

app.get('/admin/products', requireAdmin, (req, res) => {
  res.json({ ok: true, products: loadProducts() });
});

app.post('/admin/products', requireAdmin, (req, res) => {
  const products = loadProducts();
  const nextId = products.reduce((max, p) => Math.max(max, p.id), 0) + 1;
  const product = { ...req.body, id: nextId };
  products.push(product);
  saveProducts(products);
  logActivity(req.adminUser, 'created_product', product.name);
  res.json({ ok: true, product });
});

app.put('/admin/products/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const products = loadProducts();
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Product not found.' });
  products[idx] = { ...products[idx], ...req.body, id };
  saveProducts(products);
  logActivity(req.adminUser, 'updated_product', products[idx].name);
  res.json({ ok: true, product: products[idx] });
});

app.delete('/admin/products/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const products = loadProducts();
  const removed = products.find((p) => p.id === id);
  saveProducts(products.filter((p) => p.id !== id));
  logActivity(req.adminUser, 'deleted_product', removed ? removed.name : String(id));
  res.json({ ok: true });
});

// --- Stock control ---
const STOCK_HISTORY_LOG = '/opt/lifestyle-ceramics/backend/stock-history.log';
const LOW_STOCK_THRESHOLD = 5;

app.post('/admin/products/:id/adjust-stock', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { delta, reason } = req.body || {};
  if (!Number.isFinite(Number(delta)) || Number(delta) === 0) {
    return res.status(400).json({ ok: false, error: 'delta must be a non-zero number.' });
  }
  const products = loadProducts();
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Product not found.' });

  const prevQty = Number(products[idx].stockQty) || 0;
  const newQty = Math.max(0, prevQty + Number(delta));
  products[idx].stockQty = newQty;
  products[idx].stock = newQty > 0;
  saveProducts(products);

  fs.appendFile(STOCK_HISTORY_LOG, JSON.stringify({
    productId: id,
    name: products[idx].name,
    delta: Number(delta),
    prevQty,
    newQty,
    reason: reason || '',
    date: new Date().toISOString(),
  }) + '\n', () => {});

  logActivity(req.adminUser, 'adjusted_stock', `${products[idx].name}: ${prevQty} -> ${newQty}`);
  res.json({ ok: true, product: products[idx] });
});

app.get('/admin/stock/history', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ ok: true, history: readJsonLines(STOCK_HISTORY_LOG).reverse().slice(0, limit) });
});

app.get('/admin/stock/summary', requireAdmin, (req, res) => {
  const products = loadProducts();
  const lowStock = products.filter((p) => {
    const qty = Number(p.stockQty);
    return Number.isFinite(qty) && qty > 0 && qty <= LOW_STOCK_THRESHOLD;
  });
  const outOfStock = products.filter((p) => !p.stock);
  res.json({ ok: true, lowStock, outOfStock, lowStockThreshold: LOW_STOCK_THRESHOLD });
});

// --- Settings (document template branding) ---
app.get('/admin/settings', requireAdmin, (req, res) => {
  res.json({ ok: true, settings: loadSettings() });
});

app.put('/admin/settings', requireAdmin, (req, res) => {
  const settings = { ...loadSettings(), ...req.body };
  saveSettings(settings);
  logActivity(req.adminUser, 'updated_settings');
  res.json({ ok: true, settings });
});

// --- Admin users (named logins) ---
app.get('/admin/users', requireAdmin, (req, res) => {
  res.json({ ok: true, users: loadUsers().map((u) => ({ username: u.username, role: u.role })) });
});

app.post('/admin/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'Missing username or password.' });
  const users = loadUsers();
  if (users.some((u) => u.username === username)) {
    return res.status(400).json({ ok: false, error: 'Username already exists.' });
  }
  users.push({ username, password, role: role || 'admin' });
  saveUsers(users);
  logActivity(req.adminUser, 'added_user', username);
  res.json({ ok: true });
});

app.delete('/admin/users/:username', requireAdmin, (req, res) => {
  const users = loadUsers();
  if (users.length <= 1) return res.status(400).json({ ok: false, error: 'Cannot delete the last remaining user.' });
  const filtered = users.filter((u) => u.username !== req.params.username);
  saveUsers(filtered);
  logActivity(req.adminUser, 'removed_user', req.params.username);
  res.json({ ok: true });
});

// --- Activity log (audit trail) ---
app.get('/admin/activity', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ ok: true, activity: readJsonLines(ACTIVITY_LOG).reverse().slice(0, limit) });
});

// --- Client tracker (CRM) ---
// Built from existing quote-requests.log, enriched with any manually-saved
// notes in clients.json (keyed by lowercased email).
const CLIENTS_JSON = '/opt/lifestyle-ceramics/backend/clients.json';
function loadClientNotes() {
  if (!fs.existsSync(CLIENTS_JSON)) return {};
  try {
    return JSON.parse(fs.readFileSync(CLIENTS_JSON, 'utf8'));
  } catch {
    return {};
  }
}
function saveClientNotes(notes) {
  fs.writeFileSync(CLIENTS_JSON, JSON.stringify(notes, null, 2));
}

app.get('/admin/clients', requireAdmin, (req, res) => {
  // Dedupe by quoteNumber first — a quote can have multiple log lines
  // (requested, stock confirmed, sent, etc.), only the latest matters here.
  const quotesByNumber = new Map();
  readJsonLines(LOG_PATH).forEach((q) => quotesByNumber.set(q.quoteNumber, q));
  const quotes = [...quotesByNumber.values()];

  const docsByNumber = new Map();
  readJsonLines(DOCUMENTS_LOG).forEach((d) => docsByNumber.set(d.docNumber, d));
  const docs = [...docsByNumber.values()];

  const notes = loadClientNotes();
  const byEmail = new Map();

  quotes.forEach((q) => {
    const key = (q.email || '').toLowerCase();
    if (!key) return;
    if (!byEmail.has(key)) {
      byEmail.set(key, {
        email: q.email, name: q.name, phone: q.phone, company: q.company,
        quotes: [], documents: [], totalValue: 0, lastActivity: q.date,
      });
    }
    const c = byEmail.get(key);
    c.quotes.push({ quoteNumber: q.quoteNumber, date: q.date, grandTotal: q.grandTotal, status: q.status, stage: q.stage || 'requested' });
    c.totalValue += Number(q.grandTotal) || 0;
    if (new Date(q.date) > new Date(c.lastActivity)) c.lastActivity = q.date;
    // Latest quote wins for display name/phone/company in case of updates.
    if (new Date(q.date) >= new Date(c.lastActivity)) {
      c.name = q.name; c.phone = q.phone; c.company = q.company;
    }
  });

  docs.forEach((d) => {
    const key = (d.email || '').toLowerCase();
    if (!key || !byEmail.has(key)) return;
    byEmail.get(key).documents.push({ docNumber: d.docNumber, type: d.type, date: d.date, total: d.total });
  });

  const clients = [...byEmail.values()].map((c) => ({
    ...c,
    notes: notes[c.email.toLowerCase()] || '',
  })).sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  res.json({ ok: true, clients });
});

app.put('/admin/clients/:email/notes', requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const notes = loadClientNotes();
  notes[email] = (req.body && req.body.notes) || '';
  saveClientNotes(notes);
  res.json({ ok: true });
});

// --- Documents: Invoices & Receipts (built on top of the existing Quote flow) ---
const DOCUMENTS_DIR = '/opt/lifestyle-ceramics/backend/documents-private';
if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
const DOCUMENTS_LOG = '/opt/lifestyle-ceramics/backend/documents.log';

function nextDocNumber(prefix) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

// Shared layout for Invoice/Receipt PDFs — mirrors the existing Quote PDF
// styling, pulling company branding from settings.json.
function buildDocumentPdf({ docType, docNumber, name, email, phone, company, items, grandTotal, extraLines, refNumber }) {
  const settings = loadSettings();
  const filename = `${docType.toLowerCase()}-${docNumber}.pdf`;
  const filePath = path.join(DOCUMENTS_DIR, filename);
  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(20).fillColor(settings.accentColor).text(settings.companyName);
  doc.fontSize(10).fillColor('#444').text(settings.tagline || '');
  doc.moveDown(0.3);
  doc.fontSize(12).fillColor('#444').text(docType);
  doc.moveDown(1.2);

  doc.fontSize(10).fillColor('#000');
  doc.text(`${docType} Number: ${docNumber}`);
  if (refNumber) doc.text(`Reference: ${refNumber}`);
  doc.text(`Date: ${new Date().toLocaleDateString('en-ZA')}`);
  if (settings.vatNumber) doc.text(`VAT Number: ${settings.vatNumber}`);
  doc.moveDown(1);

  doc.fontSize(11).fillColor('#000').text('Billed to:', { underline: true });
  doc.fontSize(10).text(name || '');
  if (company) doc.text(company);
  if (email) doc.text(email);
  if (phone) doc.text(phone);
  doc.moveDown(1.5);

  if (items && items.length) {
    const tableTop = doc.y;
    doc.fontSize(10).fillColor('#444');
    doc.text('Item', 50, tableTop, { width: 220 });
    doc.text('Code', 270, tableTop, { width: 90 });
    doc.text('Qty', 360, tableTop, { width: 40, align: 'right' });
    doc.text('Unit Price', 400, tableTop, { width: 80, align: 'right' });
    doc.text('Line Total', 480, tableTop, { width: 70, align: 'right' });
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).strokeColor('#ccc').stroke();

    let y = tableTop + 22;
    doc.fillColor('#000');
    items.forEach((it) => {
      doc.fontSize(9);
      doc.text(String(it.name || ''), 50, y, { width: 220 });
      doc.text(String(it.code || ''), 270, y, { width: 90 });
      doc.text(String(it.qty || 1), 360, y, { width: 40, align: 'right' });
      doc.text(formatZAR(Number(it.unitPrice) || 0), 400, y, { width: 80, align: 'right' });
      doc.text(formatZAR(Number(it.lineTotal) || 0), 480, y, { width: 70, align: 'right' });
      y += 20;
    });
    doc.moveTo(50, y + 5).lineTo(550, y + 5).strokeColor('#ccc').stroke();
    doc.fontSize(11).fillColor(settings.accentColor).text(
      `Total (incl. 15% VAT): ${formatZAR(grandTotal)}`, 50, y + 15, { width: 500, align: 'right' }
    );
    doc.moveDown(2);
  }

  if (extraLines && extraLines.length) {
    doc.fontSize(10).fillColor('#000');
    extraLines.forEach((line) => doc.text(line));
    doc.moveDown(1);
  }

  if (settings.bankDetails) {
    doc.fontSize(9).fillColor('#444').text('Banking Details:', { underline: true });
    doc.fontSize(9).fillColor('#444').text(settings.bankDetails);
    doc.moveDown(1);
  }

  doc.fontSize(8).fillColor('#888').text(settings.footerTerms || '', { width: 500 });
  doc.end();

  return { filePath, filename, streamPromise: new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  }) };
}

app.post('/admin/documents/invoice', requireAdmin, async (req, res) => {
  try {
    const { quoteNumber } = req.body || {};
    if (!quoteNumber) return res.status(400).json({ ok: false, error: 'Missing quoteNumber.' });
    const quotesByNumber = new Map();
    readJsonLines(LOG_PATH).forEach((q) => quotesByNumber.set(q.quoteNumber, q));
    const quote = quotesByNumber.get(quoteNumber);
    if (!quote) return res.status(404).json({ ok: false, error: 'Quote not found.' });

    const docNumber = nextDocNumber('INV');
    const { filePath, streamPromise } = buildDocumentPdf({
      docType: 'Invoice',
      docNumber,
      name: quote.name, email: quote.email, phone: quote.phone, company: quote.company,
      items: quote.items, grandTotal: quote.grandTotal,
      refNumber: quote.quoteNumber,
    });
    await streamPromise;

    const entry = {
      docNumber, type: 'invoice', refNumber: quoteNumber,
      name: quote.name, email: quote.email, total: quote.grandTotal,
      date: new Date().toISOString(), status: 'issued', pdfPath: filePath,
    };
    fs.appendFile(DOCUMENTS_LOG, JSON.stringify(entry) + '\n', () => {});
    logActivity(req.adminUser, 'generated_invoice', `${docNumber} (from ${quoteNumber})`);
    res.json({ ok: true, docNumber });
  } catch (err) {
    console.error('Invoice generation error:', err);
    res.status(500).json({ ok: false, error: 'Could not generate invoice.' });
  }
});

app.post('/admin/documents/receipt', requireAdmin, async (req, res) => {
  try {
    const { invoiceNumber, amountPaid, paymentMethod } = req.body || {};
    if (!invoiceNumber || !amountPaid) {
      return res.status(400).json({ ok: false, error: 'Missing invoiceNumber or amountPaid.' });
    }
    const docsByNumber = new Map();
    readJsonLines(DOCUMENTS_LOG).forEach((d) => docsByNumber.set(d.docNumber, d));
    const invoice = docsByNumber.get(invoiceNumber);
    if (!invoice) return res.status(404).json({ ok: false, error: 'Invoice not found.' });

    const docNumber = nextDocNumber('REC');
    const { filePath, streamPromise } = buildDocumentPdf({
      docType: 'Receipt',
      docNumber,
      name: invoice.name, email: invoice.email,
      items: null, grandTotal: null,
      refNumber: invoice.docNumber,
      extraLines: [
        `Amount Paid: ${formatZAR(Number(amountPaid))}`,
        `Payment Method: ${paymentMethod || 'Not specified'}`,
        `For Invoice: ${invoice.docNumber}`,
      ],
    });
    await streamPromise;

    const entry = {
      docNumber, type: 'receipt', refNumber: invoiceNumber,
      name: invoice.name, email: invoice.email, total: Number(amountPaid),
      date: new Date().toISOString(), status: 'issued', pdfPath: filePath,
    };
    fs.appendFile(DOCUMENTS_LOG, JSON.stringify(entry) + '\n', () => {});

    // Payment recorded → advance the originating quote's pipeline stage.
    if (invoice.refNumber) {
      appendQuoteUpdate(invoice.refNumber, { stage: 'paid', paidAt: new Date().toISOString() });
    }

    logActivity(req.adminUser, 'generated_receipt', `${docNumber} (${formatZAR(Number(amountPaid))} for ${invoiceNumber})`);
    res.json({ ok: true, docNumber });
  } catch (err) {
    console.error('Receipt generation error:', err);
    res.status(500).json({ ok: false, error: 'Could not generate receipt.' });
  }
});

app.get('/admin/documents', requireAdmin, (req, res) => {
  const byNumber = new Map();
  readJsonLines(DOCUMENTS_LOG).forEach((d) => byNumber.set(d.docNumber, d));
  res.json({ ok: true, documents: [...byNumber.values()].reverse() });
});

// Invoices sent more than N days ago with no receipt issued against them yet.
app.get('/admin/documents/overdue', requireAdmin, (req, res) => {
  const days = Number(req.query.days) || 7;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const byNumber = new Map();
  readJsonLines(DOCUMENTS_LOG).forEach((d) => byNumber.set(d.docNumber, d));
  const docs = [...byNumber.values()];

  const invoicesWithReceipts = new Set(
    docs.filter((d) => d.type === 'receipt').map((d) => d.refNumber)
  );

  const overdue = docs.filter((d) =>
    d.type === 'invoice' &&
    d.status === 'sent' &&
    !invoicesWithReceipts.has(d.docNumber) &&
    new Date(d.sentAt || d.date).getTime() < cutoff
  ).map((d) => ({
    ...d,
    daysOverdue: Math.floor((Date.now() - new Date(d.sentAt || d.date).getTime()) / (24 * 60 * 60 * 1000)),
  }));

  res.json({ ok: true, overdue, thresholdDays: days });
});

// Monthly quoted vs invoiced vs paid totals, for the revenue trend chart.
app.get('/admin/revenue-summary', requireAdmin, (req, res) => {
  const months = Number(req.query.months) || 6;
  const quotesByNumber = new Map();
  readJsonLines(LOG_PATH).forEach((q) => quotesByNumber.set(q.quoteNumber, q));
  const quotes = [...quotesByNumber.values()];

  const docsByNumber = new Map();
  readJsonLines(DOCUMENTS_LOG).forEach((d) => docsByNumber.set(d.docNumber, d));
  const docs = [...docsByNumber.values()];

  function monthKey(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  const now = new Date();
  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }), quoted: 0, invoiced: 0, paid: 0 });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));

  quotes.forEach((q) => {
    const b = byKey.get(monthKey(q.date));
    if (b) b.quoted += Number(q.grandTotal) || 0;
  });
  docs.forEach((d) => {
    const b = byKey.get(monthKey(d.date));
    if (!b) return;
    if (d.type === 'invoice') b.invoiced += Number(d.total) || 0;
    if (d.type === 'receipt') b.paid += Number(d.total) || 0;
  });

  res.json({ ok: true, months: buckets });
});

app.get('/admin/documents/:docNumber/download', requireAdmin, (req, res) => {
  const docs = readJsonLines(DOCUMENTS_LOG);
  const doc = [...docs].reverse().find((d) => d.docNumber === req.params.docNumber);
  if (!doc || !fs.existsSync(doc.pdfPath)) return res.status(404).json({ ok: false, error: 'Document not found.' });
  res.download(doc.pdfPath, path.basename(doc.pdfPath));
});

app.post('/admin/documents/:docNumber/send', requireAdmin, async (req, res) => {
  try {
    const docs = readJsonLines(DOCUMENTS_LOG);
    const doc = [...docs].reverse().find((d) => d.docNumber === req.params.docNumber);
    if (!doc || !fs.existsSync(doc.pdfPath)) return res.status(404).json({ ok: false, error: 'Document not found.' });
    const settings = loadSettings();

    await mailer.sendMail({
      from: `"${settings.companyName}" <${process.env.LSC_SMTP_USER}>`,
      to: doc.email,
      subject: `Your ${doc.type === 'invoice' ? 'Invoice' : 'Receipt'} ${doc.docNumber} — ${settings.companyName}`,
      text: `Hi ${doc.name},\n\nPlease find your ${doc.type} ${doc.docNumber} attached.\n\nKind regards,\n${settings.companyName}`,
      attachments: [{ filename: path.basename(doc.pdfPath), path: doc.pdfPath }],
    });

    fs.appendFile(DOCUMENTS_LOG, JSON.stringify({ ...doc, status: 'sent', sentAt: new Date().toISOString() }) + '\n', () => {});

    // Invoice sent → advance the originating quote's pipeline stage.
    if (doc.type === 'invoice' && doc.refNumber) {
      appendQuoteUpdate(doc.refNumber, { stage: 'invoice_sent', invoice_sentAt: new Date().toISOString() });
    }

    logActivity(req.adminUser, 'sent_document', `${doc.docNumber} (${doc.type}) to ${doc.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Document send error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  },
});

app.post('/admin/upload-image', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
  res.json({ ok: true, url: `/uploads/products/${req.file.filename}` });
});

const uploadAttachment = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MAIL_ATTACHMENTS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.post('/admin/mailbox/upload-attachment', requireAdmin, uploadAttachment.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
  res.json({ ok: true, id: req.file.filename, filename: req.file.originalname, size: req.file.size });
});

// --- Live mailbox (unibox: real Inbox/Outbox from the actual mailbox) ---
let sentFolderNameCache = null;
async function findSentFolder() {
  if (sentFolderNameCache) return sentFolderNameCache;
  const client = imapClient();
  await client.connect();
  try {
    const list = await client.list();
    const sent = list.find((f) => f.specialUse === '\\Sent')
      || list.find((f) => /^sent/i.test(f.name) || /sent items/i.test(f.name));
    sentFolderNameCache = sent ? sent.path : 'Sent Messages';
    return sentFolderNameCache;
  } finally {
    await client.logout().catch(() => {});
  }
}

app.get('/admin/mailbox/inbox', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const messages = await fetchMailbox('INBOX', limit);
    res.json({ ok: true, messages });
  } catch (err) {
    console.error('Inbox fetch error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/mailbox/outbox', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const folder = await findSentFolder();
    const messages = await fetchMailbox(folder, limit);
    res.json({ ok: true, messages, folder });
  } catch (err) {
    console.error('Outbox fetch error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Send a new email (compose, or reply when inReplyTo/references are given),
// and append a copy into the Sent folder so Outbox reflects it immediately
// (GoDaddy's SMTP relay does not auto-save sent mail like Gmail/M365 do).
app.post('/admin/mailbox/send', requireAdmin, async (req, res) => {
  try {
    const { to, subject, body, inReplyTo, references, attachmentIds } = req.body || {};
    if (!to || !subject || !body) {
      return res.status(400).json({ ok: false, error: 'Missing to, subject or body.' });
    }

    const attachmentFiles = Array.isArray(attachmentIds)
      ? attachmentIds
        .map((id) => path.join(MAIL_ATTACHMENTS_DIR, path.basename(String(id))))
        .filter((p) => fs.existsSync(p))
      : [];

    const mailOptions = {
      from: `"Life Style Ceramics" <${process.env.LSC_SMTP_USER}>`,
      to,
      subject,
      text: body,
      ...(inReplyTo ? { inReplyTo, references: references || inReplyTo } : {}),
      ...(attachmentFiles.length ? { attachments: attachmentFiles.map((p) => ({ path: p })) } : {}),
    };

    await mailer.sendMail(mailOptions);

    try {
      const MailComposer = require('nodemailer/lib/mail-composer');
      const raw = await new MailComposer(mailOptions).compile().build();
      const folder = await findSentFolder();
      const client = imapClient();
      await client.connect();
      try {
        await client.append(folder, raw, ['\\Seen']);
      } finally {
        await client.logout().catch(() => {});
      }
    } catch (appendErr) {
      // Non-fatal — the email was sent either way, it just won't show in
      // Outbox until the mail server's own copy (if any) syncs.
      console.warn('Sent-folder append failed:', appendErr.message);
    }

    attachmentFiles.forEach((p) => fs.unlink(p, () => {}));

    res.json({ ok: true });
  } catch (err) {
    console.error('Mailbox send error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/mailbox/mark-read', requireAdmin, async (req, res) => {
  try {
    const { folder, uid } = req.body || {};
    if (!folder || !uid) return res.status(400).json({ ok: false, error: 'Missing folder or uid.' });
    const client = imapClient();
    await client.connect();
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark-read error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = 4000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Lifestyle Ceramics backend listening on 127.0.0.1:${PORT}`);
});
