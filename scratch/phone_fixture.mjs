/**
 * Synthetic fixture for the M8 phone-detection real-Chrome check.
 *
 * Contains a clearly-labelled unformatted phone (the documented gap), unrelated
 * 10-digit numbers of several identifier kinds, and other PII types so the
 * other detectors are exercised too.
 *
 * The phone value is a synthetic, documentation-reserved range value. It is
 * never a real subscriber number. Evidence records METADATA ONLY.
 */
import http from 'http';

const PHONE = '5551234567'; // synthetic, never a real subscriber number
const EMAIL = 'buyer@example.com'; // RFC 2606 reserved, never a real address
const PAN = '4111 1111 1111 1111'; // standard test PAN

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>M8 Phone Fixture</title></head>
<body>
  <h1 id="heading">Fixture Store — Contact</h1>

  <section id="gap">
    <h2>Unformatted phone in prose (the documented gap)</h2>
    <p id="prose-phone">Support line ${PHONE} available 9am to 5pm</p>
    <p id="label-phone">Phone: ${PHONE}</p>
    <p id="contact-phone">Contact Number: ${PHONE}</p>
  </section>

  <section id="neighbours">
    <h2>Unrelated 10-digit numbers that must NOT be phones</h2>
    <p id="product-id">Product ID 1234567890</p>
    <p id="order-id">Order ID 1234567890</p>
    <p id="tracking">Tracking number 1234567890</p>
    <p id="reference">Reference number 1234567890</p>
    <p id="short-serial">Serial 123456789</p>
    <p id="long-serial">Serial 123456789012</p>
  </section>

  <section id="other-pii">
    <h2>Other PII types (regression check)</h2>
    <p id="email">Contact: ${EMAIL}</p>
    <p id="pan">Card ${PAN} expires 03/27</p>
  </section>

  <section id="inputs">
    <h2>Form controls</h2>
    <label for="tel1">Phone</label><input id="tel1" name="phone" value="${PHONE}">
    <label for="sku1">Product ID</label><input id="sku1" name="product_id" value="1234567890">
  </section>
</body></html>`;

/** Returns a Promise resolving to the http server. */
export function servePhoneFixture(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/index')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
