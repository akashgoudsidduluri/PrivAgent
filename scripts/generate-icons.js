// Minimal PNG generator for PrivAgent extension icons
// Generates valid PNG files with a shield icon aesthetic without external dependencies
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPng(size, colorR, colorG, colorB) {
  // Construct uncompressed RGBA bitmap
  const rowBytes = size * 4 + 1; // 1 filter byte per row
  const rawData = Buffer.alloc(rowBytes * size);

  const radius = size / 2;
  const centerX = size / 2;
  const centerY = size / 2;

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    rawData[rowStart] = 0; // Filter: None

    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= radius - 1) {
        // Outer shield circle
        rawData[px] = colorR;     // R
        rawData[px + 1] = colorG; // G
        rawData[px + 2] = colorB; // B
        rawData[px + 3] = 255;    // A
      } else {
        // Transparent background
        rawData[px] = 0;
        rawData[px + 1] = 0;
        rawData[px + 2] = 0;
        rawData[px + 3] = 0;
      }
    }
  }

  const compressed = zlib.deflateSync(rawData);

  // PNG Header
  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR Chunk
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // Length
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(size, 8);
  ihdr.writeUInt32BE(size, 12);
  ihdr.writeUInt8(8, 16); // Bit depth
  ihdr.writeUInt8(6, 17); // ColorType RGBA
  ihdr.writeUInt8(0, 18); // Compression
  ihdr.writeUInt8(0, 19); // Filter
  ihdr.writeUInt8(0, 20); // Interlace
  const ihdrCrc = crc32(ihdr.slice(4, 21));
  ihdr.writeInt32BE(ihdrCrc, 21);

  // IDAT Chunk
  const idat = Buffer.alloc(compressed.length + 12);
  idat.writeUInt32BE(compressed.length, 0);
  idat.write('IDAT', 4);
  compressed.copy(idat, 8);
  const idatCrc = crc32(idat.slice(4, 8 + compressed.length));
  idat.writeInt32BE(idatCrc, 8 + compressed.length);

  // IEND Chunk
  const iend = Buffer.alloc(12);
  iend.writeUInt32BE(0, 0);
  iend.write('IEND', 4);
  const iendCrc = crc32(iend.slice(4, 8));
  iend.writeInt32BE(iendCrc, 8);

  return Buffer.concat([header, ihdr, idat, iend]);
}

// Standard CRC32
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) | 0;
}

const iconsDir = path.join(__dirname, '../extension/public/icons');
fs.mkdirSync(iconsDir, { recursive: true });

[16, 48, 128].forEach(size => {
  // Emerald / Blue tint for PrivAgent Shield
  const pngBuf = createPng(size, 16, 185, 129);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), pngBuf);
  console.log(`Generated icon${size}.png`);
});
