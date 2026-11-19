// Generate a print-ready QR code for the camera page.
// Usage (from this qr/ folder):  npm install   then   node make-qr.mjs https://<user>.github.io/<repo>/
import QRCode from 'qrcode';

const url = process.argv[2];
if (!url || !/^https:\/\//.test(url)) {
  console.error('Usage: node make-qr.mjs https://<your-github-username>.github.io/<repo>/');
  process.exit(1);
}

const opts = {
  errorCorrectionLevel: 'H', // survives smudges / a logo sticker in the middle
  margin: 4,                 // quiet zone required by scanners
  color: { dark: '#0b0d17', light: '#ffffff' },
};

await QRCode.toFile('cheersandclicks-qr.png', url, { ...opts, width: 2000 });
await QRCode.toFile('cheersandclicks-qr.svg', url, { ...opts, type: 'svg' });
console.log(`QR codes written for ${url}\n  qr/cheersandclicks-qr.png (2000 px, print up to ~17 cm @ 300 dpi)\n  qr/cheersandclicks-qr.svg (vector, any size)`);
