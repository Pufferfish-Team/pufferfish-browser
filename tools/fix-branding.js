// surfer writes Zen Browser's own website into every brand it applies
// (welcome page, "what's new" page, release notes, installer links).
// This removes those so Pufferfish never opens Zen's pages.
//
// Runs automatically as part of `npm.cmd run import`.

const fs = require("node:fs");
const path = require("node:path");

const BRAND_DIR = path.join(
  __dirname,
  "..",
  "engine",
  "browser",
  "branding",
  "pufferfish"
);

const SITE = "https://www.pufferfishbrowser.com/";
const RELEASES = "https://github.com/Pufferfish-Team/pufferfish-browser/releases";

// Pufferfish doesn't open a welcome or "what's new" page on first run or
// after an update. Update links go to the website (to download Pufferfish by
// hand) and to the release notes on GitHub.
const PREF_OVERRIDES = {
  "startup.homepage_override_url": "",
  "startup.homepage_welcome_url": "",
  "startup.homepage_welcome_url.additional": "",
  "app.update.url.manual": SITE,
  "app.update.url.details": RELEASES,
  "app.releaseNotesURL": RELEASES,
  "app.releaseNotesURL.aboutDialog": RELEASES,
  "app.releaseNotesURL.prompt": RELEASES,
};

function fixPrefs() {
  const file = path.join(BRAND_DIR, "pref", "firefox-branding.js");
  let text = fs.readFileSync(file, "utf8");
  for (const [name, value] of Object.entries(PREF_OVERRIDES)) {
    const line = new RegExp(`^pref\\("${name.replace(/\./g, "\\.")}",.*$`, "m");
    const replacement = `pref("${name}", ${JSON.stringify(value)});`;
    text = line.test(text)
      ? text.replace(line, replacement)
      : `${text.trimEnd()}\n${replacement}\n`;
  }
  fs.writeFileSync(file, text);
}

function fixInstallerLinks() {
  const file = path.join(BRAND_DIR, "branding.nsi");
  const text = fs
    .readFileSync(file, "utf8")
    .replace(/"https?:\/\/(www\.)?zen-browser\.app[^"]*"/g, '""')
    .replace(/"https:\/\/github\.com\/zen-browser\/[^"]*"/g, '""');
  fs.writeFileSync(file, text);
}

fixPrefs();
fixInstallerLinks();

const leftovers = ["pref/firefox-branding.js", "branding.nsi"].filter(f =>
  /zen-browser/.test(fs.readFileSync(path.join(BRAND_DIR, f), "utf8"))
);
if (leftovers.length) {
  console.error("Zen links still present in:", leftovers.join(", "));
  process.exit(1);
}
console.log("Removed Zen Browser links from the Pufferfish brand.");
