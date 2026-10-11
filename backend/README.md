# Chocoeta checkout backend

This is a Node.js + Safepay hosted-checkout starter for the plain HTML website. The browser sends product IDs and quantities; the server owns the catalog prices and creates the payment session. A signed Safepay webhook updates an order to `paid`.

## Set up sandbox mode

1. Install Node.js 18 or later.
2. Open a terminal in this `backend` folder and run `npm install`.
3. Copy `.env.example` to `.env` and enter the **sandbox** API key, secret key, and webhook HMAC secret from the Safepay sandbox dashboard. Keep `.env` private.
4. Run `npm start`. Open `http://localhost:3000` to use the website and checkout backend together.
5. In the Safepay sandbox dashboard, add the webhook endpoint `https://YOUR-PUBLIC-HTTPS-DOMAIN/api/safepay/webhook` and subscribe to `payment.succeeded` and `payment.failed`. For local webhook testing, expose the local server through an HTTPS tunnel and use its public URL.
6. Use Safepay's sandbox test payments. The result page only shows a confirmed order after the signed success webhook updates the local order.

The server stores orders in `orders.sqlite` next to this file. Back up that file and use persistent storage when deploying. For multiple server instances, replace the local SQLite file with a shared database.

## Catalog and deployment

Update the `catalog` object in `server.js` whenever products or prices change. The matching browser product list in `../script.js` controls what is displayed; the server's prices are authoritative for charging.

Deploy the website and backend together behind HTTPS, set `SITE_URL` to the public site origin, and use persistent database storage. Once Safepay approves your live merchant account and payment methods, set `SAFEPAY_ENVIRONMENT=production` and use the matching **live** API, secret, and webhook keys. Never use live credentials during local testing.

The current website does not collect a delivery address or customer contact details. Add a shipping/contact form and store that information with the order before taking live orders for physical products.
