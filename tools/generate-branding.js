// Generates every icon surfer needs for the Pufferfish brand from the two
// master SVGs in configs/branding/pufferfish (and the private browsing icons
// from logo-private.svg).
//
//   node tools/generate-branding.js
//
// Sizes 16-32 use logo-small.svg (no pill); 48 and up use logo.svg.

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const DIR = path.join(__dirname, "..", "configs", "branding", "pufferfish");
const FULL = path.join(DIR, "logo.svg");
const SMALL = path.join(DIR, "logo-small.svg");
const PRIVATE = path.join(DIR, "logo-private.svg");

const render = (svg, size) =>
  sharp(svg, { density: Math.max(72, (size / 100) * 72 * 1.5) })
    .resize(size, size)
    .png()
    .toBuffer();

const sourceFor = size => (size <= 32 ? SMALL : FULL);

// Replaces Firefox's generic installer icon (a Firefox file, so it lives in
// src/ rather than with the brand).
const SETUP_ICO = path.join(
  __dirname, "..", "src", "toolkit", "mozapps", "installer", "windows", "nsis", "setup.ico"
);

// Encodes an image as a 24-bit Windows bitmap.
async function bmp(image) {
  const { data, info } = await image
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + rowSize * height);
  out.write("BM", 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(rowSize * height, 34);
  for (let y = 0; y < height; y++) {
    // Rows run bottom to top, with pixels in blue-green-red order.
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      out[row + x * 3] = data[i + 2];
      out[row + x * 3 + 1] = data[i + 1];
      out[row + x * 3 + 2] = data[i];
    }
  }
  return out;
}

// An .ico file holding PNG images (supported since Windows Vista).
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map(i => i.data)]);
}

(async () => {
  const pngs = {};
  for (const size of [16, 22, 24, 32, 48, 64, 128, 256, 512]) {
    pngs[size] = await render(sourceFor(size), size);
    fs.writeFileSync(path.join(DIR, `logo${size}.png`), pngs[size]);
  }

  const big = await render(FULL, 1024);
  fs.writeFileSync(path.join(DIR, "logo.png"), big);
  fs.writeFileSync(path.join(DIR, "logo-mac.png"), big);

  const ico = buildIco(
    [16, 24, 32, 48, 64, 128, 256].map(size => ({ size, data: pngs[size] }))
  );
  fs.writeFileSync(path.join(DIR, "firefox.ico"), ico);
  fs.writeFileSync(path.join(DIR, "firefox64.ico"), ico);

  // Windows Start menu tiles.
  for (const size of [70, 150]) {
    fs.writeFileSync(
      path.join(DIR, `VisualElements_${size}.png`),
      await render(FULL, size)
    );
  }

  // About dialog and other in-browser logos.
  const content = path.join(DIR, "content");
  fs.mkdirSync(content, { recursive: true });
  fs.copyFileSync(FULL, path.join(content, "about-logo.svg"));

  // Private browsing: the pufferfish among coral, from logo-private.svg, in
  // place of Firefox's mask. pbmode.ico is the taskbar icon of private
  // windows; the tiles are its Start menu tiles.
  const privateIco = buildIco(
    await Promise.all(
      [16, 24, 32, 48, 64, 128, 256].map(async size => ({
        size,
        data: await render(PRIVATE, size),
      }))
    )
  );
  fs.writeFileSync(path.join(DIR, "pbmode.ico"), privateIco);
  for (const [name, size] of [
    ["PrivateBrowsing_70.png", 142],
    ["PrivateBrowsing_150.png", 300],
    ["content/about-logo-private.png", 192],
    ["content/about-logo-private@2x.png", 384],
  ]) {
    fs.writeFileSync(path.join(DIR, name), await render(PRIVATE, size));
  }

  // Installer artwork (24-bit BMPs, the only format the installer reads):
  // the header strip at the top right of each page, its right-to-left copy,
  // and the tall panel down the left of the first and last pages.
  const header = await bmp(
    sharp({ create: { width: 150, height: 57, channels: 3, background: "#ffffff" } })
      .composite([{ input: await render(SMALL, 48), left: 96, top: 4 }])
  );
  fs.writeFileSync(path.join(DIR, "wizHeader.bmp"), header);
  fs.writeFileSync(path.join(DIR, "wizHeaderRTL.bmp"), await bmp(
    sharp({ create: { width: 150, height: 57, channels: 3, background: "#ffffff" } })
      .composite([{ input: await render(SMALL, 48), left: 6, top: 4 }])
  ));
  const panel = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314">
    <defs><linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1F9BC0"/><stop offset="1" stop-color="#0E3347"/>
    </linearGradient></defs>
    <rect width="164" height="314" fill="url(#sea)"/>
    <g fill="#ffffff" fill-opacity=".18">
      <circle cx="34" cy="236" r="9"/><circle cx="52" cy="210" r="5"/>
      <circle cx="40" cy="186" r="3"/><circle cx="128" cy="270" r="7"/>
      <circle cx="140" cy="246" r="4"/>
    </g>
  </svg>`);
  fs.writeFileSync(path.join(DIR, "wizWatermark.bmp"), await bmp(
    sharp(panel).composite([{ input: await render(FULL, 112), left: 26, top: 50 }])
  ));

  // The installer and uninstaller's own icon (Firefox uses a generic one).
  fs.writeFileSync(SETUP_ICO, ico);

  console.log("Branding icons written to", DIR);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
