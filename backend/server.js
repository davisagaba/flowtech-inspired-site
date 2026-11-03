const express = require('express');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const multer = require('multer');
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

const mailer = nodemailer.createTransport({
  host: process.env.LSC_SMTP_HOST || 'smtpout.secureserver.net',
  port: Number(process.env.LSC_SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.LSC_SMTP_USER,
    pass: process.env.LSC_SMTP_PASS,
  },
});

function requireAdmin(req, res, next) {
  const pw = req.query.password || req.headers['x-admin-password'];
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
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
    fs.appendFile(
      LOG_PATH,
      JSON.stringify({ ...quote, status: 'sent', sentAt: new Date().toISOString() }) + '\n',
      () => {}
    );

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
  res.json({ ok: true, product });
});

app.put('/admin/products/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const products = loadProducts();
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Product not found.' });
  products[idx] = { ...products[idx], ...req.body, id };
  saveProducts(products);
  res.json({ ok: true, product: products[idx] });
});

app.delete('/admin/products/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const products = loadProducts().filter((p) => p.id !== id);
  saveProducts(products);
  res.json({ ok: true });
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

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = 4000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Lifestyle Ceramics backend listening on 127.0.0.1:${PORT}`);
});
