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
  // Formal document letterhead (Quotation, and future Invoice/Delivery Note/
  // etc.) — kept separate from the storefront's brand companyName/tagline.
  legalName: 'LIFESTYLE CERAMICS (PTY) LTD',
  legalAddress: '118 Strand Street, Cape Town, Western Cape, South Africa',
  companyRegNo: '1998/017285/07',
  landline: '+27 87 147 0677',
  whatsappNumber: '+27 78 031 6138',
  // Printed as CREATED BY / LAST OPERATOR on every formal document,
  // regardless of which admin account actually issued it.
  documentOperatorName: 'Lebogang Mokoena',
  salesRepTitle: 'Sales Representative',
  website: 'lyfestyleceramics.co.za',
  deliveryTerms: 'Free delivery is included on all orders above R20,000 within South Africa.\nStandard lead time for delivery is 24–48 hours from the date of order.',
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

// --- Formal documents (Quotation now; Invoice/Delivery Note/Credit Note/
// Purchase Order/Statement are designed for but not built — see handoff). ---
const FORMAL_DOCS_JSON = '/opt/lifestyle-ceramics/backend/formal-documents.json';
const FORMAL_SEQ_JSON = '/opt/lifestyle-ceramics/backend/formal-doc-sequences.json';
const FORMAL_DOCS_DIR = '/opt/lifestyle-ceramics/backend/formal-documents-private';
const DOCUMENT_ASSETS_DIR = '/opt/lifestyle-ceramics/backend/document-assets';
if (!fs.existsSync(FORMAL_DOCS_DIR)) fs.mkdirSync(FORMAL_DOCS_DIR, { recursive: true });

function loadFormalDocs() {
  if (!fs.existsSync(FORMAL_DOCS_JSON)) return [];
  try { return JSON.parse(fs.readFileSync(FORMAL_DOCS_JSON, 'utf8')); } catch { return []; }
}
function saveFormalDocs(docs) {
  fs.writeFileSync(FORMAL_DOCS_JSON, JSON.stringify(docs, null, 2));
}

// One running sequence per document type per calendar year, atomic via
// synchronous read-modify-write (single-process Node, no concurrent writers).
function nextFormalDocNumber(typePrefix) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const key = `${typePrefix}-${year}`;
  let seq = {};
  if (fs.existsSync(FORMAL_SEQ_JSON)) {
    try { seq = JSON.parse(fs.readFileSync(FORMAL_SEQ_JSON, 'utf8')); } catch { seq = {}; }
  }
  seq[key] = (seq[key] || 0) + 1;
  fs.writeFileSync(FORMAL_SEQ_JSON, JSON.stringify(seq, null, 2));
  const running = String(seq[key]).padStart(4, '0');
  return `LC-${typePrefix}-${year}-${month}-${running}`;
}

// Matches the sample's "R 1,900.00" formatting exactly (comma thousands,
// period decimal) — not en-ZA's actual convention (space/comma), which the
// sample template doesn't follow.
function money(n) {
  return 'R ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// --- Reply templates (reusable canned replies, with {{name}} etc. tokens) ---
const TEMPLATES_JSON = '/opt/lifestyle-ceramics/backend/reply-templates.json';
const DEFAULT_TEMPLATES = [
  { id: 'followup', name: 'Follow-up', body: 'Hi {{name}},\n\nJust following up on your recent enquiry. Please let us know if you have any questions or would like to proceed.\n\nKind regards,\nLife Style Ceramics' },
  { id: 'stock-check', name: 'Checking Stock', body: 'Hi {{name}},\n\nThank you for your patience — we are confirming stock availability for your requested items and will update you shortly.\n\nKind regards,\nLife Style Ceramics' },
  { id: 'thank-you', name: 'Thank You', body: 'Hi {{name}},\n\nThank you for your business! Please don\'t hesitate to reach out if you need anything further.\n\nKind regards,\nLife Style Ceramics' },
];
function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_JSON)) {
    fs.writeFileSync(TEMPLATES_JSON, JSON.stringify(DEFAULT_TEMPLATES, null, 2));
    return DEFAULT_TEMPLATES;
  }
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_JSON, 'utf8'));
  } catch {
    return DEFAULT_TEMPLATES;
  }
}
function saveTemplates(templates) {
  fs.writeFileSync(TEMPLATES_JSON, JSON.stringify(templates, null, 2));
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
async function fetchMailbox(folder, limit, offset = 0) {
  const client = imapClient();
  const messages = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const mailbox = client.mailbox;
      const total = mailbox.exists;
      if (total > 0) {
        const end = Math.max(1, total - offset);
        const start = Math.max(1, end - limit + 1);
        if (start > end) return messages;
        for await (const msg of client.fetch(`${start}:${end}`, { envelope: true, flags: true, source: true })) {
          let snippet = '';
          let body = '';
          let attachments = [];
          try {
            const parsed = await simpleParser(msg.source);
            body = (parsed.text || '').trim().slice(0, 5000);
            snippet = body.replace(/\s+/g, ' ').slice(0, 200);
            attachments = (parsed.attachments || []).map((a, idx) => ({
              index: idx, filename: a.filename || `attachment-${idx + 1}`, size: a.size, contentType: a.contentType,
            }));
          } catch {
            /* ignore parse failure, snippet/body/attachments stay empty */
          }
          messages.push({
            uid: msg.uid,
            folder,
            from: msg.envelope.from && msg.envelope.from[0] ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address}>`.trim() : '',
            fromAddress: msg.envelope.from && msg.envelope.from[0] ? msg.envelope.from[0].address : '',
            to: msg.envelope.to && msg.envelope.to[0] ? msg.envelope.to[0].address : '',
            cc: (msg.envelope.cc || []).map((a) => a.address).join(', '),
            subject: msg.envelope.subject || '(no subject)',
            date: msg.envelope.date,
            seen: msg.flags.has('\\Seen'),
            messageId: msg.envelope.messageId || '',
            snippet,
            body,
            attachments,
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
  req.adminRole = matched.role || 'staff';
  next();
}

// Gate for admin-only actions (user management, branding/settings, deleting
// products, viewing the audit trail). Staff accounts can run day-to-day
// operations but not touch these. Use after requireAdmin on the same route.
function requireOwner(req, res, next) {
  if (req.adminRole !== 'admin') {
    return res.status(403).json({ ok: false, error: 'This action is restricted to admin accounts.' });
  }
  next();
}

app.get('/admin/whoami', requireAdmin, (req, res) => {
  res.json({ ok: true, username: req.adminUser, role: req.adminRole });
});

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
  const formalDocsById = new Map(loadFormalDocs().map((d) => [d.id, d]));
  const quotes = [...quotesByNumber.values()].map((q) => {
    const formalDoc = q.formalQuoteId ? formalDocsById.get(q.formalQuoteId) : null;
    return { ...q, emailOpenedAt: formalDoc ? formalDoc.emailOpenedAt || null : null };
  });

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

// 1x1 transparent GIF used as an email open-tracking pixel. Public and
// unauthenticated — it's loaded directly by the recipient's mail client.
const TRACKING_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64');
app.get('/track/open/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  try {
    const docs = loadFormalDocs();
    const idx = docs.findIndex((d) => d.id === id);
    if (idx !== -1) {
      if (!docs[idx].emailOpenedAt) docs[idx].emailOpenedAt = new Date().toISOString();
      docs[idx].emailOpenCount = (docs[idx].emailOpenCount || 0) + 1;
      saveFormalDocs(docs);
    }
  } catch {
    /* tracking must never break the pixel response */
  }
  res.end(TRACKING_PIXEL);
});

app.post('/quote', (req, res) => {
  try {
    const { name, email, phone, company, timeline, message, items } = req.body || {};

    if (!name || !email || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Missing required fields (name, email, items).' });
    }

    const quoteNumber = nextQuoteNumber();
    const date = new Date();
    const grandTotal = items.reduce((sum, it) => sum + (Number(it.lineTotal) || 0), 0);

    // Auto-create a matching draft in the formal Quotation system (the
    // LC-QT-numbered template), pre-filled from the website submission.
    // Cart unitPrice is VAT-inclusive; the formal template adds its own 15%
    // on top, so it's unwound here to avoid double-charging VAT.
    const docs = loadFormalDocs();
    const nextId = docs.reduce((max, d) => Math.max(max, d.id || 0), 0) + 1;
    const formalItems = items.map((it) => ({
      code: it.code || '',
      description: it.name || '',
      manufacturerCode: '',
      qty: Number(it.qty) || 1,
      unitPrice: Math.round(((Number(it.unitPrice) || 0) / 1.15) * 100) / 100,
      weight: 0,
    }));
    const formalQuote = {
      id: nextId,
      type: 'QT',
      status: 'draft',
      docNumber: null,
      revision: 0,
      parentDocumentId: null,
      date: date.toISOString().slice(0, 10),
      customerName: name,
      customerCompany: company || '',
      customerPhone: phone || '',
      customerEmail: email,
      account: '',
      customerVatNo: '',
      refNo: '',
      discountRate: 10,
      vatRate: 0.15,
      items: formalItems,
      totalWeight: 0,
      accountRep: '',
      notes: [timeline, message].filter(Boolean).join(' — '),
      createdBy: 'Website',
      lastOperator: 'Website',
      createdAt: new Date().toISOString(),
      sourceQuoteNumber: quoteNumber,
    };
    docs.push(formalQuote);
    saveFormalDocs(docs);

    // Log the lead for pipeline/client tracking, linked to the new draft —
    // no PDF is generated or sent here; staff reviews and fills in the
    // formal quote (account, VAT no, weights) before issuing it.
    const logLine = JSON.stringify({
      quoteNumber, name, email, phone, company, timeline, message, items, grandTotal, date,
      status: 'pending_review',
      stage: 'requested',
      formalQuoteId: nextId,
    }) + '\n';
    fs.appendFile(LOG_PATH, logLine, () => {});

    // Alert staff immediately — fire-and-forget so a slow/failed email never
    // delays or breaks the customer's confirmation response.
    const settings = loadSettings();
    mailer.sendMail({
      from: `"${settings.legalName || settings.companyName} Website" <${process.env.LSC_SMTP_USER}>`,
      to: process.env.LSC_SMTP_USER,
      subject: `New Quote Request from ${name} (${quoteNumber})`,
      text: [
        `A new quote request just came in from the website.`,
        '',
        `Name: ${name}`,
        `Email: ${email}`,
        phone ? `Phone: ${phone}` : null,
        company ? `Company: ${company}` : null,
        '',
        'Items:',
        ...items.map((it) => `- ${it.name} x${it.qty} (${formatZAR(Number(it.lineTotal) || 0)})`),
        '',
        `Total: ${formatZAR(grandTotal)}`,
        '',
        `A matching draft quotation has already been created — open it from the admin panel's Quotes tab ("Open Formal Quote") to review and issue it.`,
      ].filter(Boolean).join('\n'),
    }).catch((err) => console.warn('Quote-request staff alert failed:', err.message));

    res.json({ ok: true, quoteNumber });
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
    // Leads from before the formal-quotation system was wired in still carry
    // the old ad-hoc PDF and send that way; newer leads have a linked
    // formalQuoteId instead and are sent from the Formal Quotes tab.
    if (quote.formalQuoteId && !quote.pdfPath) {
      return res.status(400).json({
        ok: false,
        error: 'This lead uses the new Formal Quotation system — open it in the Formal Quotes tab to issue and send it.',
      });
    }
    if (!quote.pdfPath || !fs.existsSync(quote.pdfPath)) {
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
  return CATALOG.find((p) => p.slug === slug || (p.slugHistory || []).includes(slug));
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
  // Preserve every slug this product has ever had, so an old shared/indexed
  // link keeps resolving after a rename instead of 404ing.
  if (req.body.name && req.body.name !== products[idx].name) {
    const oldSlug = slugify(products[idx].name);
    const history = products[idx].slugHistory || [];
    if (!history.includes(oldSlug)) history.push(oldSlug);
    products[idx].slugHistory = history;
  }
  products[idx] = { ...products[idx], ...req.body, id };
  saveProducts(products);
  logActivity(req.adminUser, 'updated_product', products[idx].name);
  res.json({ ok: true, product: products[idx] });
});

app.delete('/admin/products/:id', requireAdmin, requireOwner, (req, res) => {
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

app.put('/admin/settings', requireAdmin, requireOwner, (req, res) => {
  const settings = { ...loadSettings(), ...req.body };
  saveSettings(settings);
  logActivity(req.adminUser, 'updated_settings');
  res.json({ ok: true, settings });
});

// --- Reply templates ---
// Readable by any signed-in user (staff need these when replying); managed
// (add/edit/delete) by admins only, same as other shared configuration.
app.get('/admin/templates', requireAdmin, (req, res) => {
  res.json({ ok: true, templates: loadTemplates() });
});

app.post('/admin/templates', requireAdmin, requireOwner, (req, res) => {
  const { name, body } = req.body || {};
  if (!name || !body) return res.status(400).json({ ok: false, error: 'Missing name or body.' });
  const templates = loadTemplates();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + crypto.randomBytes(2).toString('hex');
  templates.push({ id, name, body });
  saveTemplates(templates);
  logActivity(req.adminUser, 'added_template', name);
  res.json({ ok: true, template: { id, name, body } });
});

app.put('/admin/templates/:id', requireAdmin, requireOwner, (req, res) => {
  const { name, body } = req.body || {};
  const templates = loadTemplates();
  const idx = templates.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Template not found.' });
  if (name) templates[idx].name = name;
  if (body) templates[idx].body = body;
  saveTemplates(templates);
  logActivity(req.adminUser, 'edited_template', templates[idx].name);
  res.json({ ok: true, template: templates[idx] });
});

app.delete('/admin/templates/:id', requireAdmin, requireOwner, (req, res) => {
  const templates = loadTemplates();
  const removed = templates.find((t) => t.id === req.params.id);
  saveTemplates(templates.filter((t) => t.id !== req.params.id));
  logActivity(req.adminUser, 'deleted_template', removed ? removed.name : req.params.id);
  res.json({ ok: true });
});

// --- Admin users (named logins) ---
app.get('/admin/users', requireAdmin, requireOwner, (req, res) => {
  res.json({ ok: true, users: loadUsers().map((u) => ({ username: u.username, role: u.role })) });
});

app.post('/admin/users', requireAdmin, requireOwner, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'Missing username or password.' });
  const users = loadUsers();
  if (users.some((u) => u.username === username)) {
    return res.status(400).json({ ok: false, error: 'Username already exists.' });
  }
  users.push({ username, password, role: role || 'staff' });
  saveUsers(users);
  logActivity(req.adminUser, 'added_user', username);
  res.json({ ok: true });
});

app.put('/admin/users/:username', requireAdmin, requireOwner, (req, res) => {
  const { role, password } = req.body || {};
  const users = loadUsers();
  const idx = users.findIndex((u) => u.username === req.params.username);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'User not found.' });

  const adminCount = users.filter((u) => u.role === 'admin').length;
  if (role && role !== 'admin' && users[idx].role === 'admin' && adminCount <= 1) {
    return res.status(400).json({ ok: false, error: 'Cannot demote the last remaining admin.' });
  }

  if (role) users[idx].role = role;
  if (password) users[idx].password = password;
  saveUsers(users);
  logActivity(req.adminUser, 'edited_user', `${req.params.username}${role ? ' -> role: ' + role : ''}${password ? ' (password changed)' : ''}`);
  res.json({ ok: true, user: { username: users[idx].username, role: users[idx].role } });
});

app.delete('/admin/users/:username', requireAdmin, requireOwner, (req, res) => {
  const users = loadUsers();
  if (users.length <= 1) return res.status(400).json({ ok: false, error: 'Cannot delete the last remaining user.' });
  const target = users.find((u) => u.username === req.params.username);
  const adminCount = users.filter((u) => u.role === 'admin').length;
  if (target && target.role === 'admin' && adminCount <= 1) {
    return res.status(400).json({ ok: false, error: 'Cannot delete the last remaining admin.' });
  }
  const filtered = users.filter((u) => u.username !== req.params.username);
  saveUsers(filtered);
  logActivity(req.adminUser, 'removed_user', req.params.username);
  res.json({ ok: true });
});

// --- Activity log (audit trail) ---
app.get('/admin/activity', requireAdmin, requireOwner, (req, res) => {
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

// Auto-detects every real email exchanged with this client by matching their
// address against the live mailbox (Inbox + Sent) — no manual linking, this
// connects automatically off the address on file for the quote.
app.get('/admin/clients/:email/emails', requireAdmin, async (req, res) => {
  try {
    const target = decodeURIComponent(req.params.email).toLowerCase();
    if (!target) return res.status(400).json({ ok: false, error: 'Missing email.' });

    const sentFolder = await findSentFolder();
    const [inbox, outbox] = await Promise.all([
      fetchMailbox('INBOX', 100),
      fetchMailbox(sentFolder, 100),
    ]);

    const matches = (addr) => String(addr || '').toLowerCase().includes(target);

    const received = inbox
      .filter((m) => matches(m.fromAddress) || matches(m.from))
      .map((m) => ({ direction: 'received', subject: m.subject, date: m.date, snippet: m.snippet, seen: m.seen }));
    const sent = outbox
      .filter((m) => matches(m.to))
      .map((m) => ({ direction: 'sent', subject: m.subject, date: m.date, snippet: m.snippet, seen: true }));

    const thread = [...received, ...sent].sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ ok: true, thread });
  } catch (err) {
    console.error('Client email thread error:', err);
    res.status(500).json({ ok: false, error: 'Could not load email history.' });
  }
});

// Every quote/invoice/receipt PDF already generated for this client, for the
// "Attach Document" picker in Reply — adjustable per send, never forced.
app.get('/admin/clients/:email/documents', requireAdmin, (req, res) => {
  const target = decodeURIComponent(req.params.email).toLowerCase();

  const quotesByNumber = new Map();
  readJsonLines(LOG_PATH).forEach((q) => quotesByNumber.set(q.quoteNumber, q));
  const quoteDocs = [...quotesByNumber.values()]
    .filter((q) => (q.email || '').toLowerCase() === target && q.pdfPath && fs.existsSync(q.pdfPath))
    .map((q) => ({ type: 'quote', id: q.quoteNumber, label: `Quote ${q.quoteNumber} (${formatZAR(q.grandTotal)})`, date: q.date }));

  const docsByNumber = new Map();
  readJsonLines(DOCUMENTS_LOG).forEach((d) => docsByNumber.set(d.docNumber, d));
  const otherDocs = [...docsByNumber.values()]
    .filter((d) => (d.email || '').toLowerCase() === target && d.pdfPath && fs.existsSync(d.pdfPath))
    .map((d) => ({ type: 'document', id: d.docNumber, label: `${d.type === 'invoice' ? 'Invoice' : 'Receipt'} ${d.docNumber} (${formatZAR(d.total)})`, date: d.date }));

  const documents = [...quoteDocs, ...otherDocs].sort((a, b) => new Date(b.date) - new Date(a.date));

  // Client summary for template tailoring (name/company + most recent
  // quote details) — so a template can reference more than just {{name}}.
  const clientQuotes = [...quotesByNumber.values()]
    .filter((q) => (q.email || '').toLowerCase() === target)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const latest = clientQuotes[0];
  const client = latest ? {
    name: latest.name || '',
    company: latest.company || '',
    phone: latest.phone || '',
    latestQuoteNumber: latest.quoteNumber,
    latestAmount: formatZAR(latest.grandTotal),
  } : null;

  res.json({ ok: true, documents, client });
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

// Formal Quotation PDF — matches the client-supplied sample (see
// claude-code-handoff/QUOTATION-HANDOFF.md) structurally: header with logo,
// Bill To + info box, item table, terms box, footer table, and a bottom row
// of stamp / release notice / totals. Built generically enough that future
// document types (Invoice, Delivery Note, etc.) can reuse this shell with a
// different title/columns/terms per the handoff's section 11.
const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const NAVY = '#14263F', BLUE = '#2E86C1', GREY = '#D0D0D0', LIGHT_GREY = '#F2F2F2';

function buildQuotationPdf(quote) {
  const settings = loadSettings();
  const filename = `quotation-${quote.docNumber}.pdf`;
  const filePath = path.join(FORMAL_DOCS_DIR, filename);
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // ---- Header ----
  let y = MARGIN;
  doc.fontSize(14).fillColor(NAVY).font('Helvetica-Bold').text(settings.legalName, MARGIN, y, { width: 340 });
  y = doc.y + 2;
  doc.fontSize(9).font('Helvetica').fillColor('#000');
  doc.text(settings.legalAddress, MARGIN, y, { width: 340 });
  doc.text(`Email: ${settings.companyEmail || process.env.LSC_SMTP_USER}`, MARGIN, doc.y, { width: 340 });
  doc.text(`Tel: ${settings.landline} | WhatsApp: ${settings.whatsappNumber}`, MARGIN, doc.y, { width: 340 });
  doc.text(`VAT Reg No: ${settings.vatNumber} | Reg No: ${settings.companyRegNo}`, MARGIN, doc.y, { width: 340 });

  const logoPath = path.join(DOCUMENT_ASSETS_DIR, 'logo.png');
  if (fs.existsSync(logoPath)) {
    try { doc.image(logoPath, MARGIN + 350, MARGIN, { width: 150 }); } catch { /* skip if unreadable */ }
  }

  y = Math.max(doc.y, MARGIN + 60) + 10;
  doc.moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y).strokeColor(NAVY).lineWidth(1.2).stroke();
  y += 16;

  // ---- Title + Document Number ----
  doc.fontSize(24).font('Helvetica-Bold').fillColor('#000').text('Quotation', MARGIN, y);
  doc.fontSize(11).font('Helvetica-Bold').text('Document Number:', MARGIN + 260, y + 6, { continued: true })
    .font('Helvetica').text(`  ${quote.docNumber}`);
  y = doc.y + 14;

  // ---- Bill To (left) + Info box (right) ----
  const billToTop = y;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text('Bill To:', MARGIN, y);
  y = doc.y + 2;
  doc.fontSize(9).font('Helvetica');
  [
    ['Customer Name:', quote.customerName],
    ['Company Name:', quote.customerCompany],
    ['Phone:', quote.customerPhone],
    ['Email:', quote.customerEmail],
  ].forEach(([label, value]) => {
    doc.font('Helvetica-Bold').text(label, MARGIN, doc.y, { continued: true, width: 280 })
      .font('Helvetica').text(' ' + (value || ''));
  });

  const infoBoxX = MARGIN + 290;
  const infoBoxW = CONTENT_W - 290;
  const infoRows = [
    ['Date:', quote.date],
    ['Account:', quote.account || ''],
    ['VAT Reg No:', quote.customerVatNo || ''],
    ['Ref No:', quote.refNo || ''],
  ];
  let rowY = billToTop - 4;
  const rowH = 18;
  infoRows.forEach(([label, value], i) => {
    doc.rect(infoBoxX, rowY, infoBoxW, rowH).fillColor(i % 2 === 0 ? '#fff' : LIGHT_GREY).fill();
    doc.fontSize(9).fillColor('#000').font('Helvetica-Bold').text(label, infoBoxX + 8, rowY + 5, { width: 90 });
    doc.font('Helvetica').text(String(value), infoBoxX + 100, rowY + 5, { width: infoBoxW - 110, align: 'right' });
    rowY += rowH;
  });
  doc.rect(infoBoxX, billToTop - 4, infoBoxW, rowH * infoRows.length).strokeColor(GREY).lineWidth(0.5).stroke();

  y = Math.max(doc.y, rowY) + 18;

  // ---- Intro line ----
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#000')
    .text('Dear Customer, we take pleasure in quoting you for the following products:', MARGIN, y, { width: CONTENT_W, align: 'center' });
  y = doc.y + 14;

  // ---- Item table ----
  const cols = { code: MARGIN, desc: MARGIN + 55, qty: MARGIN + 320, unit: MARGIN + 360, total: MARGIN + 440 };
  doc.rect(MARGIN, y, CONTENT_W, 18).fillColor(GREY).fill();
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#000');
  doc.text('CODE', cols.code + 4, y + 5);
  doc.text('DESCRIPTION', cols.desc, y + 5);
  doc.text('QTY', cols.qty, y + 5, { width: 40, align: 'right' });
  doc.text('UNIT PRICE', cols.unit, y + 5, { width: 80, align: 'right' });
  doc.text('TOTAL', cols.total, y + 5, { width: CONTENT_W - (cols.total - MARGIN), align: 'right' });
  y += 22;

  let subtotal = 0;
  (quote.items || []).forEach((it) => {
    const qty = Number(it.qty) || 0;
    const unitPrice = Number(it.unitPrice) || 0;
    const lineTotal = qty * unitPrice;
    subtotal += lineTotal;

    doc.fontSize(9).font('Helvetica').fillColor('#000');
    const descLines = [it.description || it.name || ''];
    if (it.manufacturerCode) descLines.push(`Manufacturer Code: ${it.manufacturerCode}`);
    if (it.notes) descLines.push(it.notes);

    doc.text(it.code || '', cols.code + 4, y, { width: 50 });
    doc.text(descLines.join('\n'), cols.desc, y, { width: 265 });
    const rowTop = y;
    doc.text(String(qty), cols.qty, rowTop, { width: 40, align: 'right' });
    doc.text(money(unitPrice), cols.unit, rowTop, { width: 80, align: 'right' });
    doc.text(money(lineTotal), cols.total, rowTop, { width: CONTENT_W - (cols.total - MARGIN), align: 'right' });

    y = Math.max(doc.y, rowTop + 14) + 8;
  });

  const vat = subtotal * (Number(quote.vatRate ?? 0.15));
  const discountRate = Number(quote.discountRate) || 0;
  const discount = (subtotal + vat) * (discountRate / 100);
  const total = subtotal + vat - discount;

  // Anchors the terms box / footer table / bottom row near the bottom of
  // the page — matching the sample's spacing — instead of them trailing
  // immediately after a short item list and leaving the page half-empty.
  // Still grows downward normally if enough items push past this point.
  const BOTTOM_SECTION_MIN_Y = 560;
  y = Math.max(y + 10, BOTTOM_SECTION_MIN_Y);

  // ---- Terms box ----
  // Dedicated legal wording for this document type — deliberately NOT the
  // storefront's generic footerTerms setting (different purpose/audience).
  const DEFAULT_QUOTATION_TERMS = "QUOTATIONS ARE SUBJECT TO EXCHANGE RATE FLUCTUATIONS. ALL GOODS ARE SUPPLIED IN TERMS OF OUR STANDARD TERMS AND CONDITIONS OF SALE WHICH ARE AVAILABLE ON OUR WEBSITE AND/OR ON REQUEST.\nTHIS IS NOT A TAX INVOICE. NO GOODS MAY BE PICKED OR SUPPLIED ON THIS QUOTATION.\nA TAX INVOICE MUST BE SUPPLIED FOR ALL GOODS COLLECTED.\nE&OE";
  const termsText = quote.termsText || settings.quotationTerms || DEFAULT_QUOTATION_TERMS;
  const termsTop = y;
  doc.fontSize(7.5).font('Helvetica').fillColor('#000').text(termsText, MARGIN + 10, y + 8, { width: CONTENT_W - 20, align: 'center' });
  const termsBottom = doc.y + 8;
  doc.rect(MARGIN, termsTop, CONTENT_W, termsBottom - termsTop).strokeColor('#000').lineWidth(1).stroke();
  y = termsBottom + 10;

  // ---- Footer table ----
  const footCols = [
    ['CREATED BY', settings.documentOperatorName || quote.createdBy || ''],
    ['LAST OPERATOR', settings.documentOperatorName || quote.lastOperator || quote.createdBy || ''],
    ['ACCOUNT REP', quote.accountRep || ''],
    ['WEIGHT', `${quote.totalWeight || 0}KG`],
    ['INTERNAL REF', quote.internalRef || ''],
    ['PAGE', '1'],
  ];
  const footColW = CONTENT_W / footCols.length;
  doc.rect(MARGIN, y, CONTENT_W, 16).fillColor(LIGHT_GREY).fill();
  footCols.forEach(([label], i) => {
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#000').text(label, MARGIN + i * footColW + 4, y + 4, { width: footColW - 8 });
  });
  y += 16;
  doc.rect(MARGIN, y, CONTENT_W, 16).strokeColor(GREY).lineWidth(0.5).stroke();
  footCols.forEach(([, value], i) => {
    doc.fontSize(8).font('Helvetica').fillColor('#000').text(String(value), MARGIN + i * footColW + 4, y + 4, { width: footColW - 8 });
  });
  footCols.forEach((_, i) => {
    if (i === 0) return;
    doc.moveTo(MARGIN + i * footColW, y).lineTo(MARGIN + i * footColW, y + 16).strokeColor(GREY).lineWidth(0.5).stroke();
  });
  y += 26;

  // ---- Bottom row: stamp / release notice / totals ----
  const bottomTop = y;
  const stampPath = path.join(DOCUMENT_ASSETS_DIR, 'stamp-blue-tilted.png');
  if (quote.status !== 'draft' && fs.existsSync(stampPath)) {
    try { doc.image(stampPath, MARGIN, bottomTop, { width: 110 }); } catch { /* skip if unreadable */ }
  }

  const noticeX = MARGIN + 150, noticeW = 185;
  doc.rect(noticeX, bottomTop, noticeW, 80).strokeColor('#000').lineWidth(1).stroke();
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#000').text(
    "GOODS WILL NOT BE RELEASED UNTIL EFT'S AND DEPOSITS ARE REFLECTED ON LIFESTYLE CERAMICS' BANK STATEMENT",
    noticeX + 8, bottomTop + 8, { width: noticeW - 16, align: 'center' }
  );
  doc.fontSize(7.5).font('Helvetica-Bold').text('Please note this is not a VAT Invoice', noticeX + 8, doc.y + 8, { width: noticeW - 16, align: 'center' });
  doc.font('Helvetica-Bold').text('Quote expires in 30 Days', noticeX + 8, doc.y + 4, { width: noticeW - 16, align: 'center' });

  const totalsX = noticeX + noticeW + 12;
  const totalsW = PAGE_W - MARGIN - totalsX;
  const totalsRows = [
    ['Total Excl Vat', 'ZAR', money(subtotal)],
    ['Vat', 'ZAR', money(vat)],
    ['Discount', `${discountRate}%`, money(discount)],
    ['Total', 'ZAR', money(total)],
  ];
  let totalsY = bottomTop + 4;
  totalsRows.forEach(([label, mid, value]) => {
    const bold = label === 'Total';
    doc.fontSize(bold ? 10 : 9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#000');
    doc.text(label, totalsX, totalsY, { width: 68 });
    doc.text(mid, totalsX + 70, totalsY, { width: 30 });
    doc.text(value, totalsX + 100, totalsY, { width: totalsW - 100, align: 'right' });
    totalsY += bold ? 20 : 16;
  });

  doc.end();

  return {
    filePath, filename,
    totals: { subtotal, vat, discount, discountRate, total },
    streamPromise: new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    }),
  };
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

// Per-product spec sheet PDFs — attached automatically to quotation emails
// for any line item whose code matches the product.
const SPEC_SHEETS_DIR = path.join(PUBLIC_DIR, 'uploads', 'spec-sheets');
if (!fs.existsSync(SPEC_SHEETS_DIR)) fs.mkdirSync(SPEC_SHEETS_DIR, { recursive: true });

const uploadSpecSheet = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, SPEC_SHEETS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are allowed.'));
    cb(null, true);
  },
});

app.post('/admin/upload-spec-sheet', requireAdmin, uploadSpecSheet.single('specSheet'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
  res.json({ ok: true, url: `/uploads/spec-sheets/${req.file.filename}` });
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

// --- Live mailbox (unibox: full Titan/IMAP folder set, not just Inbox/Sent) ---
let folderCache = null;
async function listFolders() {
  if (folderCache) return folderCache;
  const client = imapClient();
  await client.connect();
  try {
    folderCache = await client.list();
    return folderCache;
  } finally {
    await client.logout().catch(() => {});
  }
}
async function findSpecialFolder(specialUse, nameRegex, fallback) {
  const list = await listFolders();
  const found = list.find((f) => f.specialUse === specialUse) || list.find((f) => nameRegex.test(f.name));
  return found ? found.path : fallback;
}
async function findSentFolder() { return findSpecialFolder('\\Sent', /^sent/i, 'Sent Messages'); }
async function findTrashFolder() { return findSpecialFolder('\\Trash', /^trash|deleted/i, 'Trash'); }
async function findDraftsFolder() { return findSpecialFolder('\\Drafts', /^drafts/i, 'Drafts'); }
async function findJunkFolder() { return findSpecialFolder('\\Junk', /^junk|spam/i, 'Junk'); }
async function findArchiveFolder() { return findSpecialFolder('\\Archive', /^archive/i, 'Archive'); }

// Lists every real folder in the mailbox, labeled for the unibox's folder
// tabs — the same set Titan's own webmail shows (Inbox/Sent/Drafts/Trash/
// Junk/Archive), not a fixed Inbox+Outbox pair.
app.get('/admin/mailbox/folders', requireAdmin, async (req, res) => {
  try {
    const [sent, drafts, trash, junk, archive] = await Promise.all([
      findSentFolder(), findDraftsFolder(), findTrashFolder(), findJunkFolder(), findArchiveFolder(),
    ]);
    res.json({
      ok: true,
      folders: [
        { key: 'inbox', label: 'Inbox', path: 'INBOX' },
        { key: 'outbox', label: 'Sent', path: sent },
        { key: 'drafts', label: 'Drafts', path: drafts },
        { key: 'junk', label: 'Junk', path: junk },
        { key: 'archive', label: 'Archive', path: archive },
        { key: 'trash', label: 'Trash', path: trash },
      ],
    });
  } catch (err) {
    console.error('Folder list error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/mailbox/inbox', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const messages = await fetchMailbox('INBOX', limit, offset);
    res.json({ ok: true, messages });
  } catch (err) {
    console.error('Inbox fetch error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/mailbox/outbox', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const folder = await findSentFolder();
    const messages = await fetchMailbox(folder, limit, offset);
    res.json({ ok: true, messages, folder });
  } catch (err) {
    console.error('Outbox fetch error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Generic fetch for any folder by its exact IMAP path (Drafts/Junk/Archive/
// Trash, or any custom folder) — used alongside the dedicated inbox/outbox
// routes above so existing callers keep working unchanged.
app.get('/admin/mailbox/folder', requireAdmin, async (req, res) => {
  try {
    const path = req.query.path;
    if (!path) return res.status(400).json({ ok: false, error: 'Missing path.' });
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const messages = await fetchMailbox(path, limit, offset);
    res.json({ ok: true, messages });
  } catch (err) {
    console.error('Folder fetch error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Send a new email (compose, or reply when inReplyTo/references are given),
// and append a copy into the Sent folder so Outbox reflects it immediately
// (GoDaddy's SMTP relay does not auto-save sent mail like Gmail/M365 do).
// Resolves {type: 'quote'|'document', id} refs to real PDF paths already on
// disk (quotes-private or documents-private), so a reply can attach an
// existing quote/invoice/receipt without re-uploading it.
function resolveDocumentRefs(documentRefs) {
  if (!Array.isArray(documentRefs) || documentRefs.length === 0) return [];
  const quotesByNumber = new Map();
  readJsonLines(LOG_PATH).forEach((q) => quotesByNumber.set(q.quoteNumber, q));
  const docsByNumber = new Map();
  readJsonLines(DOCUMENTS_LOG).forEach((d) => docsByNumber.set(d.docNumber, d));

  return documentRefs
    .map((ref) => {
      const record = ref.type === 'quote' ? quotesByNumber.get(ref.id) : docsByNumber.get(ref.id);
      return record && record.pdfPath && fs.existsSync(record.pdfPath)
        ? { path: record.pdfPath, filename: path.basename(record.pdfPath) }
        : null;
    })
    .filter(Boolean);
}

app.post('/admin/mailbox/send', requireAdmin, async (req, res) => {
  try {
    const { to, cc, bcc, subject, body, inReplyTo, references, attachmentIds, documentRefs } = req.body || {};
    if (!to || !subject || !body) {
      return res.status(400).json({ ok: false, error: 'Missing to, subject or body.' });
    }

    const attachmentFiles = Array.isArray(attachmentIds)
      ? attachmentIds
        .map((id) => path.join(MAIL_ATTACHMENTS_DIR, path.basename(String(id))))
        .filter((p) => fs.existsSync(p))
      : [];

    const resolvedDocs = resolveDocumentRefs(documentRefs);
    const allAttachments = [
      ...attachmentFiles.map((p) => ({ path: p })),
      ...resolvedDocs,
    ];

    const mailOptions = {
      from: `"Life Style Ceramics" <${process.env.LSC_SMTP_USER}>`,
      to,
      subject,
      text: body,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(inReplyTo ? { inReplyTo, references: references || inReplyTo } : {}),
      ...(allAttachments.length ? { attachments: allAttachments } : {}),
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

// Move a message between folders (used for Delete -> Trash, and for
// "move to" actions) — mirrors Titan's own webmail behavior.
app.post('/admin/mailbox/move', requireAdmin, async (req, res) => {
  try {
    const { fromFolder, uid, toFolder } = req.body || {};
    if (!fromFolder || !uid || !toFolder) {
      return res.status(400).json({ ok: false, error: 'Missing fromFolder, uid or toFolder.' });
    }
    const client = imapClient();
    await client.connect();
    try {
      const lock = await client.getMailboxLock(fromFolder);
      try {
        await client.messageMove({ uid: String(uid) }, toFolder, { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Mailbox move error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Delete = move to Trash (never a permanent expunge), same as clicking
// Delete in Titan's webmail.
app.post('/admin/mailbox/delete', requireAdmin, async (req, res) => {
  try {
    const { folder, uid } = req.body || {};
    if (!folder || !uid) return res.status(400).json({ ok: false, error: 'Missing folder or uid.' });
    const trash = await findTrashFolder();
    const client = imapClient();
    await client.connect();
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageMove({ uid: String(uid) }, trash, { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    logActivity(req.adminUser, 'deleted_email', `uid ${uid} from ${folder}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mailbox delete error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Downloads one attachment from a message by re-fetching and re-parsing it
// (attachment binary content isn't kept in memory between requests).
app.get('/admin/mailbox/attachment', requireAdmin, async (req, res) => {
  try {
    const { folder, uid, index } = req.query;
    if (!folder || !uid || index === undefined) {
      return res.status(400).json({ ok: false, error: 'Missing folder, uid or index.' });
    }
    const client = imapClient();
    await client.connect();
    let source;
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        source = msg && msg.source;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    if (!source) return res.status(404).json({ ok: false, error: 'Message not found.' });

    const parsed = await simpleParser(source);
    const attachment = (parsed.attachments || [])[Number(index)];
    if (!attachment) return res.status(404).json({ ok: false, error: 'Attachment not found.' });

    res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${(attachment.filename || 'attachment').replace(/"/g, '')}"`);
    res.send(attachment.content);
  } catch (err) {
    console.error('Attachment download error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Public contact form submission (services.html "Contact Us") — emails
// straight to the business inbox, logged for a basic record/audit trail.
const CONTACT_LOG = '/opt/lifestyle-ceramics/backend/contact-messages.log';
app.post('/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: 'Missing name, email or message.' });
    }
    const settings = loadSettings();
    const date = new Date();

    await mailer.sendMail({
      from: `"${settings.companyName} Website" <${process.env.LSC_SMTP_USER}>`,
      to: process.env.LSC_SMTP_USER,
      replyTo: email,
      subject: `New website contact form message from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
    });

    fs.appendFile(CONTACT_LOG, JSON.stringify({ name, email, message, date }) + '\n', () => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ ok: false, error: 'Could not send message.' });
  }
});

// --- Formal Quotations (numbered LC-QT-YYYY-MM-NNNN documents) ---
app.get('/admin/formal-quotes', requireAdmin, (req, res) => {
  res.json({ ok: true, quotes: loadFormalDocs().filter((d) => d.type === 'QT').reverse() });
});

app.post('/admin/formal-quotes', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.customerName || !Array.isArray(b.items) || b.items.length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing customerName or items.' });
  }
  const docs = loadFormalDocs();
  const nextId = docs.reduce((max, d) => Math.max(max, d.id || 0), 0) + 1;
  const totalWeight = b.items.reduce((sum, it) => sum + (Number(it.weight) || 0) * (Number(it.qty) || 0), 0);
  const parentDoc = b.parentDocumentId ? docs.find((d) => d.id === Number(b.parentDocumentId)) : null;

  const quote = {
    id: nextId,
    type: 'QT',
    status: 'draft',
    docNumber: null,
    revision: 0,
    parentDocumentId: parentDoc ? parentDoc.id : null,
    replacesDocNumber: parentDoc ? (parentDoc.docNumber || `#${parentDoc.id}`) : null,
    date: new Date().toISOString().slice(0, 10),
    customerName: b.customerName,
    customerCompany: b.customerCompany || '',
    customerPhone: b.customerPhone || '',
    customerEmail: b.customerEmail || '',
    account: b.account || '',
    customerVatNo: b.customerVatNo || '',
    refNo: b.refNo || '',
    discountRate: Number(b.discountRate) || 0,
    vatRate: Number(b.vatRate ?? 0.15),
    items: b.items,
    totalWeight,
    accountRep: b.accountRep || '',
    notes: b.notes || '',
    createdBy: req.adminUser,
    lastOperator: req.adminUser,
    createdAt: new Date().toISOString(),
  };
  docs.push(quote);
  saveFormalDocs(docs);
  logActivity(req.adminUser, 'created_formal_quote', `draft #${nextId} for ${quote.customerName}`);
  res.json({ ok: true, quote });
});

app.put('/admin/formal-quotes/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const docs = loadFormalDocs();
  const idx = docs.findIndex((d) => d.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Quote not found.' });
  const b = req.body || {};
  const isDraft = docs[idx].status === 'draft';

  if (!isDraft) {
    // Once issued, items/pricing/doc number are locked, but these reference
    // fields carry no financial weight and commonly get filled in after the
    // fact (e.g. a client calls back with their account/VAT/PO number) — so
    // they stay editable without forcing a full void-and-reissue.
    const allowed = ['account', 'customerVatNo', 'refNo', 'accountRep', 'itemWeights'];
    const hasDisallowedChange = Object.keys(b).some((k) => !allowed.includes(k));
    if (hasDisallowedChange) {
      return res.status(400).json({ ok: false, error: 'Only Account, VAT Reg No, Ref No, Account Rep and item weights can be edited after issuing — void and reissue for description/qty/price changes.' });
    }
    if (Array.isArray(b.itemWeights)) {
      if (b.itemWeights.length !== docs[idx].items.length) {
        return res.status(400).json({ ok: false, error: 'Weight list does not match the number of line items.' });
      }
      docs[idx].items = docs[idx].items.map((it, i) => ({ ...it, weight: Number(b.itemWeights[i]) || 0 }));
      docs[idx].totalWeight = docs[idx].items.reduce((sum, it) => sum + (Number(it.weight) || 0) * (Number(it.qty) || 0), 0);
    }
    allowed.filter((k) => k !== 'itemWeights').forEach((k) => { if (k in b) docs[idx][k] = b[k]; });
    docs[idx].lastOperator = req.adminUser;
    if (docs[idx].pdfPath) {
      const { filePath, streamPromise } = buildQuotationPdf(docs[idx]);
      await streamPromise;
      docs[idx].pdfPath = filePath;
    }
    saveFormalDocs(docs);
    logActivity(req.adminUser, 'edited_formal_quote', `#${id} (reference fields)`);
    return res.json({ ok: true, quote: docs[idx] });
  }

  const totalWeight = Array.isArray(b.items)
    ? b.items.reduce((sum, it) => sum + (Number(it.weight) || 0) * (Number(it.qty) || 0), 0)
    : docs[idx].totalWeight;
  docs[idx] = { ...docs[idx], ...b, totalWeight, lastOperator: req.adminUser, id, type: 'QT' };
  saveFormalDocs(docs);
  logActivity(req.adminUser, 'edited_formal_quote', `#${id}`);
  res.json({ ok: true, quote: docs[idx] });
});

// Locks in a document number, generates the PDF (with stamp), and marks the
// quote 'sent'-ready (status becomes 'issued' until actually emailed).
app.post('/admin/formal-quotes/:id/issue', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const docs = loadFormalDocs();
    const idx = docs.findIndex((d) => d.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Quote not found.' });

    const quote = docs[idx];
    if (!quote.docNumber) {
      quote.docNumber = nextFormalDocNumber('QT');
      quote.internalRef = quote.docNumber.split('-').pop();
    }
    // Standing defaults — every quote uses the same house account/VAT
    // number unless a different one was explicitly entered beforehand.
    if (!String(quote.account || '').trim()) quote.account = 'CASR023';
    if (!String(quote.customerVatNo || '').trim()) quote.customerVatNo = '4010136408';
    if (!String(quote.refNo || '').trim()) quote.refNo = quote.docNumber;
    quote.status = 'issued';
    quote.lastOperator = req.adminUser;
    quote.issuedAt = new Date().toISOString();

    const { filePath, totals, streamPromise } = buildQuotationPdf(quote);
    await streamPromise;
    quote.pdfPath = filePath;
    quote.totals = totals;

    docs[idx] = quote;
    saveFormalDocs(docs);
    logActivity(req.adminUser, 'issued_formal_quote', quote.docNumber);
    res.json({ ok: true, quote });
  } catch (err) {
    console.error('Issue formal quote error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/formal-quotes/:id/pdf', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const quote = loadFormalDocs().find((d) => d.id === id);
  if (!quote || !quote.pdfPath || !fs.existsSync(quote.pdfPath)) {
    return res.status(404).json({ ok: false, error: 'PDF not generated yet — issue the quote first.' });
  }
  res.download(quote.pdfPath, path.basename(quote.pdfPath));
});

// Opens an already-issued quote's PDF inline in the browser tab — no forced
// file download, just viewing it.
app.get('/admin/formal-quotes/:id/view', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const quote = loadFormalDocs().find((d) => d.id === id);
  if (!quote || !quote.pdfPath || !fs.existsSync(quote.pdfPath)) {
    return res.status(404).json({ ok: false, error: 'PDF not generated yet — issue the quote first.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(quote.pdfPath)}"`);
  fs.createReadStream(quote.pdfPath).pipe(res);
});

// Renders the CURRENT draft data as a PDF for review, without issuing it —
// no document number is consumed and nothing is persisted. Opens inline.
app.get('/admin/formal-quotes/:id/preview', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const docs = loadFormalDocs();
    const quote = docs.find((d) => d.id === id);
    if (!quote) return res.status(404).json({ ok: false, error: 'Quote not found.' });

    const previewQuote = { ...quote, docNumber: quote.docNumber || 'PREVIEW — NOT YET ISSUED', status: 'draft' };
    const { filePath, streamPromise } = buildQuotationPdf(previewQuote);
    await streamPromise;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="quotation-preview.pdf"');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(filePath, () => {}));
  } catch (err) {
    console.error('Preview formal quote error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Builds the default subject/body/attachments for a formal quote's send
// email — shared by the preview endpoint (what the compose window shows)
// and the actual send endpoint (if the caller didn't override them).
function buildQuotationEmail(quote) {
  const settings = loadSettings();
  const operatorName = settings.documentOperatorName || 'Sales Team';
  const body = [
    `Dear ${quote.customerName},`,
    '',
    'Please find attached our quotation for your review, including pricing and estimated delivery timelines.',
    '',
    'Please note:',
    ...(settings.deliveryTerms || '').split('\n').map((line) => `- ${line}`),
    '',
    "Should you require any clarification or wish to make adjustments, please don't hesitate to get in touch — we're happy to assist.",
    '',
    'We look forward to your feedback and the opportunity to work with you.',
    '',
    'Kind regards,',
    '',
    operatorName,
    settings.salesRepTitle || '',
    settings.legalName,
    '',
    `Mobile: ${settings.whatsappNumber}`,
    `Email: ${process.env.LSC_SMTP_USER}`,
    `Website: ${settings.website}`,
    '',
    `This quotation is valid for 30 days from the date of issue and is subject to our standard terms and conditions of sale.`,
  ].join('\n');

  const catalogProducts = loadProducts();
  const specAttachments = [];
  const seenSpecPaths = new Set();
  (quote.items || []).forEach((item) => {
    const product = catalogProducts.find((p) => p.code && item.code && p.code === item.code);
    if (product && product.specSheet) {
      const specPath = path.join(PUBLIC_DIR, product.specSheet.replace(/^\//, ''));
      if (!seenSpecPaths.has(specPath) && fs.existsSync(specPath)) {
        seenSpecPaths.add(specPath);
        specAttachments.push({
          filename: `${product.name.replace(/[^a-z0-9]+/gi, '-')}-Specification.pdf`,
          path: specPath,
          label: `${product.name} — Specification Sheet`,
        });
      }
    }
  });

  return {
    to: quote.customerEmail,
    subject: `Your Quotation ${quote.docNumber} — ${settings.legalName}`,
    body,
    pdfAttachment: { filename: path.basename(quote.pdfPath), label: 'Quotation PDF' },
    specAttachments,
  };
}

// Returns the default email contents without sending — used to pre-fill the
// compose window so staff can review/edit before anything goes out.
app.get('/admin/formal-quotes/:id/email-preview', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const quote = loadFormalDocs().find((d) => d.id === id);
  if (!quote) return res.status(404).json({ ok: false, error: 'Quote not found.' });
  if (!quote.pdfPath) return res.status(400).json({ ok: false, error: 'Issue the quote first.' });
  const email = buildQuotationEmail(quote);
  res.json({ ok: true, ...email });
});

app.post('/admin/formal-quotes/:id/send', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const docs = loadFormalDocs();
    const idx = docs.findIndex((d) => d.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Quote not found.' });
    const quote = docs[idx];
    if (!quote.pdfPath || !fs.existsSync(quote.pdfPath)) {
      return res.status(400).json({ ok: false, error: 'Issue the quote (generate its PDF) before sending.' });
    }
    if (!quote.customerEmail) {
      return res.status(400).json({ ok: false, error: 'This quote has no customer email on file.' });
    }
    const settings = loadSettings();
    const defaults = buildQuotationEmail(quote);
    const subject = req.body && req.body.subject ? req.body.subject : defaults.subject;
    const emailBody = req.body && req.body.body ? req.body.body : defaults.body;

    // Plain-text body plus an HTML version carrying an invisible open-
    // tracking pixel, so staff can see in the admin when a client has
    // actually opened the quotation email.
    const trackingPixelUrl = `https://lyfestyleceramics.co.za/api/track/open/${quote.id}`;
    const htmlBody = emailBody
      .split('\n').map((line) => line || '<br>').join('<br>')
      + `<img src="${trackingPixelUrl}" width="1" height="1" alt="" style="display:none;">`;

    const mailOptions = {
      from: `"${settings.legalName}" <${process.env.LSC_SMTP_USER}>`,
      to: quote.customerEmail,
      subject,
      text: emailBody,
      html: htmlBody,
      attachments: [
        { filename: path.basename(quote.pdfPath), path: quote.pdfPath },
        ...defaults.specAttachments,
      ],
    };

    await mailer.sendMail(mailOptions);

    try {
      const MailComposer = require('nodemailer/lib/mail-composer');
      const raw = await new MailComposer(mailOptions).compile().build();
      const sentFolder = await findSentFolder();
      const client = imapClient();
      await client.connect();
      try {
        await client.append(sentFolder, raw, ['\\Seen']);
      } finally {
        await client.logout().catch(() => {});
      }
    } catch (appendErr) {
      // Non-fatal — the email was sent either way, it just won't show in
      // Outbox until the mail server's own copy (if any) syncs.
      console.warn('Sent-folder append failed (formal quote):', appendErr.message);
    }

    quote.status = 'sent';
    quote.sentAt = new Date().toISOString();
    docs[idx] = quote;
    saveFormalDocs(docs);

    // If this draft was auto-created from a website lead, advance that
    // lead's pipeline stage too, so the Quotes tab stepper stays accurate.
    const leadsByNumber = new Map();
    readJsonLines(LOG_PATH).forEach((l) => leadsByNumber.set(l.quoteNumber, l));
    const linkedLead = [...leadsByNumber.values()].find((l) => l.formalQuoteId === id);
    if (linkedLead) {
      appendQuoteUpdate(linkedLead.quoteNumber, { status: 'sent', stage: 'quote_sent', sentAt: new Date().toISOString() });
    }

    logActivity(req.adminUser, 'sent_formal_quote', `${quote.docNumber} to ${quote.customerEmail}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Send formal quote error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/formal-quotes/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const docs = loadFormalDocs();
  const quote = docs.find((d) => d.id === id);
  if (!quote) return res.status(404).json({ ok: false, error: 'Quote not found.' });
  if (quote.status === 'draft') {
    saveFormalDocs(docs.filter((d) => d.id !== id));
  } else {
    // Numbered documents are never deleted — void keeps the number reserved.
    quote.status = 'void';
    saveFormalDocs(docs);
  }
  logActivity(req.adminUser, 'removed_formal_quote', String(id));
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = 4000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Lifestyle Ceramics backend listening on 127.0.0.1:${PORT}`);
});
