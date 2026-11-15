// Generates every icon surfer needs for the Pufferfish brand from the two
// master SVGs in configs/branding/pufferfish.
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

const render = (svg, size) =>
  sharp(svg, { density: Math.max(72, (size / 100) * 72 * 1.5) })
    .resize(size, size)
    .png()
    .toBuffer();

const sourceFor = size => (size <= 32 ? SMALL : FULL);

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

  console.log("Branding icons written to", DIR);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
