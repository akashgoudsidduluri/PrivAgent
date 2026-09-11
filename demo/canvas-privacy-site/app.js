// Synthetic Financial Data drawn strictly to Canvas Pixels (NOT in DOM)
const SYNTHETIC_DATA = {
  name: 'Rahul Sharma',
  email: 'rahul.sharma@example.com',
  phone: '+91 98765 43210',
  accountNumber: '1234 5678 9012',
  pan: 'ABCDE1234F',
  otp: '492019',
  cardNumber: '4111 1111 1111 1111',
  cvv: '893',
  expiry: '08/29',
  balance: 'INR 1,48,500.00',
};

function renderStatementCanvas() {
  const canvas = document.getElementById('statementCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  // Background
  const bgGrad = ctx.createLinearGradient(0, 0, w, h);
  bgGrad.addColorStop(0, '#0f172a');
  bgGrad.addColorStop(1, '#020617');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  // Border & Grid Lines
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.strokeRect(10, 10, w - 20, h - 20);

  // Statement Header
  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('APEX SECURE PRIVATE WEALTH — STATEMENT OF ACCOUNT', 30, 45);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px monospace';
  ctx.fillText('CONFIDENTIAL DOCUMENT • GENERATED ON: 12-SEP-2026', 30, 68);

  // Horizontal separator
  ctx.strokeStyle = '#334155';
  ctx.beginPath();
  ctx.moveTo(30, 85);
  ctx.lineTo(w - 30, 85);
  ctx.stroke();

  // Column 1: Account & Identity Details
  const col1X = 40;
  let y = 120;
  const lineSpacing = 38;

  const drawField = (label, value, isMonospace = true) => {
    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 11px -apple-system, sans-serif';
    ctx.fillText(label.toUpperCase(), col1X, y);

    ctx.fillStyle = '#f8fafc';
    ctx.font = isMonospace ? 'bold 15px monospace' : 'bold 15px -apple-system, sans-serif';
    ctx.fillText(value, col1X, y + 18);

    y += lineSpacing;
  };

  drawField('Account Holder', SYNTHETIC_DATA.name, false);
  drawField('Account Number', SYNTHETIC_DATA.accountNumber, true);
  drawField('Permanent Account Number (PAN)', SYNTHETIC_DATA.pan, true);
  drawField('Security Token (OTP Verification)', `One-Time Passcode (OTP): ${SYNTHETIC_DATA.otp}`, true);

  // Column 2: Contact & Balance Details
  const col2X = 440;
  y = 120;

  const drawCol2Field = (label, value, isMonospace = true) => {
    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 11px -apple-system, sans-serif';
    ctx.fillText(label.toUpperCase(), col2X, y);

    ctx.fillStyle = '#f8fafc';
    ctx.font = isMonospace ? 'bold 15px monospace' : 'bold 15px -apple-system, sans-serif';
    ctx.fillText(value, col2X, y + 18);

    y += lineSpacing;
  };

  drawCol2Field('Registered Email', SYNTHETIC_DATA.email, true);
  drawCol2Field('Primary Contact Phone', SYNTHETIC_DATA.phone, true);
  drawCol2Field('Available Clear Balance', SYNTHETIC_DATA.balance, true);
  drawCol2Field('Vault Branch Routing', 'APEX-VAULT-MUMBAI-091', true);

  // Footer stamp inside canvas
  ctx.fillStyle = '#475569';
  ctx.font = 'italic 11px monospace';
  ctx.fillText('All statement data rendered into HTML5 <canvas> pixels. Zero DOM text representation.', 30, h - 25);
}

function renderCardCanvas() {
  const canvas = document.getElementById('cardCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  // Metallic Card Gradient
  const cardGrad = ctx.createLinearGradient(0, 0, w, h);
  cardGrad.addColorStop(0, '#1e1b4b');
  cardGrad.addColorStop(0.5, '#312e81');
  cardGrad.addColorStop(1, '#0f172a');
  ctx.fillStyle = cardGrad;

  // Rounded rectangle card
  const r = 14;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - r);
  ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h);
  ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(168, 85, 247, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Bank name on card
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('APEX VAULT PLATINUM', 26, 36);

  // Chip graphic
  ctx.fillStyle = '#eab308';
  ctx.fillRect(26, 52, 40, 30);
  ctx.strokeStyle = '#ca8a04';
  ctx.strokeRect(26, 52, 40, 30);

  // Card Number (Luhn-valid synthetic Visa)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px monospace';
  ctx.fillText(SYNTHETIC_DATA.cardNumber, 26, 128);

  // Expiry & CVV
  ctx.fillStyle = '#94a3b8';
  ctx.font = '9px sans-serif';
  ctx.fillText('VALID THRU', 26, 160);
  ctx.fillText('SECURITY CODE (CVV)', 140, 160);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText(SYNTHETIC_DATA.expiry, 26, 178);
  ctx.fillText(`CVV: ${SYNTHETIC_DATA.cvv}`, 140, 178);

  // Cardholder Name
  ctx.fillStyle = '#94a3b8';
  ctx.font = '9px sans-serif';
  ctx.fillText('CARDHOLDER NAME', 26, 212);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(SYNTHETIC_DATA.name.toUpperCase(), 26, 230);

  // Visa-style logo
  ctx.fillStyle = '#38bdf8';
  ctx.font = 'italic bold 22px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('VISA', w - 26, 230);
  ctx.textAlign = 'left';
}

function verifyDOMZeroLeakage() {
  const box = document.getElementById('dom-proof-box');
  const textEl = document.getElementById('dom-proof-text');
  if (!box || !textEl) return;

  const htmlContent = document.body.innerHTML;
  const secrets = [
    SYNTHETIC_DATA.email,
    SYNTHETIC_DATA.phone,
    SYNTHETIC_DATA.cardNumber,
    SYNTHETIC_DATA.pan,
    SYNTHETIC_DATA.accountNumber,
  ];

  let leakedCount = 0;
  const leaks = [];

  for (const s of secrets) {
    if (htmlContent.includes(s)) {
      leakedCount++;
      leaks.push(s);
    }
  }

  box.style.display = 'block';
  if (leakedCount === 0) {
    textEl.innerHTML = '✅ <strong>CONFIRMED: ZERO DOM LEAKAGE</strong><br/>' +
      'All 5 sensitive targets (Email, Phone, Card, PAN, Account Number) exist exclusively in canvas pixels.<br/>' +
      'A DOM-only privacy scanner will detect <strong>0 sensitive elements</strong>.';
    box.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    box.style.background = 'rgba(16, 185, 129, 0.08)';
    box.style.color = '#a7f3d0';
  } else {
    textEl.textContent = `❌ Warning: Found ${leakedCount} values in DOM: ${leaks.join(', ')}`;
    box.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    box.style.background = 'rgba(239, 68, 68, 0.08)';
    box.style.color = '#fca5a5';
  }
}

// Event Listeners
document.getElementById('btn-redraw')?.addEventListener('click', () => {
  renderStatementCanvas();
  renderCardCanvas();
});

document.getElementById('btn-inspect-dom')?.addEventListener('click', verifyDOMZeroLeakage);

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  renderStatementCanvas();
  renderCardCanvas();
});
