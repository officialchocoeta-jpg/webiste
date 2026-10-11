import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import Safepay from '@sfpy/node-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(here, '..');
const app = express();
const port = Number(process.env.PORT || 3000);
const siteUrl = (process.env.SITE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const environment = process.env.SAFEPAY_ENVIRONMENT || 'sandbox';
const apiKey = process.env.SAFEPAY_API_KEY;
const secretKey = process.env.SAFEPAY_SECRET_KEY;
const webhookSecret = process.env.SAFEPAY_WEBHOOK_SECRET;

if (!['sandbox', 'production'].includes(environment)) throw new Error('SAFEPAY_ENVIRONMENT must be sandbox or production.');
if (!apiKey || !secretKey || !webhookSecret) {
  console.warn('Safepay credentials are missing. Copy .env.example to .env and enter your sandbox credentials.');
}

const safepayHost = environment === 'sandbox'
  ? 'https://sandbox.api.getsafepay.com'
  : 'https://api.getsafepay.com';
const safepay = secretKey ? Safepay(secretKey, { authType: 'secret', host: safepayHost }) : null;

// Authoritative prices are set here. Never accept a price sent by the browser.
const catalog = {
  'choco-nova-combo': { name: 'Choco Nova Combo', price: 999 },
  'nova-bar': { name: 'Nova Bar', price: 99 },
  'nova-classic-jar': { name: 'Nova Classic Jar', price: 399 }
};

const db = new Database(path.join(here, 'orders.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    amount INTEGER NOT NULL,
    items_json TEXT NOT NULL,
    status TEXT NOT NULL,
    tracker TEXT UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
`);

function now() { return new Date().toISOString(); }
function requireSafepay(res) {
  if (!safepay || !apiKey || !webhookSecret) {
    res.status(503).json({ error: 'Checkout is not configured yet. Add Safepay credentials to backend/.env.' });
    return false;
  }
  return true;
}

// Safepay needs the raw request bytes to verify the HMAC signature.
app.post('/api/safepay/webhook', express.raw({ type: 'application/json', limit: '256kb' }), (req, res) => {
  if (!requireSafepay(res)) return;
  const signature = req.get('X-SFPY-SIGNATURE');
  let event;
  try {
    event = safepay.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    console.error('Rejected Safepay webhook:', error.message);
    return res.status(400).send('Invalid webhook signature');
  }

  const eventId = event.token;
  const tracker = event.data?.tracker;
  const receivedAt = now();
  const applyEvent = db.transaction(() => {
    const inserted = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, type, received_at) VALUES (?, ?, ?)')
      .run(eventId, event.type, receivedAt);
    if (!inserted.changes || !tracker) return;
    if (event.type === 'payment.succeeded' && event.data.success !== false && event.data.currency === 'PKR') {
      db.prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE tracker = ? AND amount = ?")
        .run(receivedAt, tracker, Number(event.data.amount));
    } else if (event.type === 'payment.failed') {
      db.prepare("UPDATE orders SET status = 'failed', updated_at = ? WHERE tracker = ? AND status = 'pending'")
        .run(receivedAt, tracker);
    }
  });
  try {
    applyEvent();
    return res.sendStatus(200);
  } catch (error) {
    console.error('Could not record Safepay webhook:', error);
    return res.sendStatus(500);
  }
});

app.use(express.json({ limit: '32kb' }));

app.post('/api/checkout', async (req, res) => {
  if (!requireSafepay(res)) return;
  const incoming = req.body?.items;
  if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > 30) {
    return res.status(400).json({ error: 'Your cart is empty or invalid.' });
  }

  const items = [];
  for (const line of incoming) {
    const product = catalog[line?.productId];
    const qty = Number(line?.qty);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      return res.status(400).json({ error: 'A cart item is invalid. Please refresh and try again.' });
    }
    items.push({ productId: line.productId, name: product.name, price: product.price, qty });
  }
  const amount = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000000) {
    return res.status(400).json({ error: 'The cart total is outside the supported range.' });
  }

  const orderId = randomUUID();
  const created = now();
  db.prepare('INSERT INTO orders (id, amount, items_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(orderId, amount, JSON.stringify(items), 'creating', created, created);

  try {
    const session = await safepay.payments.session.setup({
      merchant_api_key: apiKey,
      intent: 'CYBERSOURCE',
      mode: 'payment',
      entry_mode: 'raw',
      currency: 'PKR',
      amount: amount * 100,
      metadata: { order_id: orderId },
      include_fees: false
    });
    const tracker = session.data.tracker.token;
    const auth = await safepay.auth.passport.create();
    const checkoutUrl = safepay.checkouts.payment.create({
      tracker,
      tbt: auth.data,
      environment,
      source: 'hosted',
      redirect_url: `${siteUrl}/payment-result.html?order=${encodeURIComponent(orderId)}`,
      cancel_url: `${siteUrl}/payment-result.html?order=${encodeURIComponent(orderId)}&cancelled=1`
    });
    db.prepare("UPDATE orders SET tracker = ?, status = 'pending', updated_at = ? WHERE id = ?")
      .run(tracker, now(), orderId);
    return res.json({ checkoutUrl });
  } catch (error) {
    console.error('Safepay checkout setup failed:', error);
    db.prepare("UPDATE orders SET status = 'setup_failed', updated_at = ? WHERE id = ?").run(now(), orderId);
    return res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const order = db.prepare('SELECT id, amount, status FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  return res.json({ orderId: order.id, amount: order.amount, status: order.status });
});

app.use(express.static(siteDir));
app.listen(port, () => console.log(`Chocoeta site and checkout server listening on port ${port}`));
