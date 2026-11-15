// Prepares a Pufferfish release's update files, after `npx surfer package`:
//
//   npm run prepare-update
//
// 1. Signs the update package (dist/output.mar) with the Pufferfish update
//    key in configs/keys/update-signing, and checks the signature against the
//    certificate built into Pufferfish. Pufferfish refuses unsigned updates.
// 2. Saves it as dist/windows.mar, the name the GitHub release must use.
// 3. Runs `surfer updates-browser`, which writes update.xml with the signed
//    package's size and checksum and its GitHub download address.
// 4. Copies update.xml into the update site folder (../PufferfishUpdates, or
//    the PUFFERFISH_UPDATES_DIR environment variable).
//
// It doesn't upload or deploy anything. The steps for that are printed at the
// end.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const OBJ = path.join(ROOT, "engine", "obj-x86_64-pc-windows-msvc");
const KEYS = path.join(ROOT, "configs", "keys", "update-signing");
const CERT = path.join(
  ROOT,
  "engine",
  "toolkit",
  "mozapps",
  "update",
  "updater",
  "dep1.der"
);
const DIST = path.join(ROOT, "dist");
const UPDATES_DIR =
  process.env.PUFFERFISH_UPDATES_DIR ||
  path.join(ROOT, "..", "PufferfishUpdates");

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  let result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    fail(`"${command} ${args.join(" ")}" failed.`);
  }
}

function findMar() {
  let saved = path.join(ROOT, ".surfer", "dynamicConfig.marPath.json");
  if (fs.existsSync(saved)) {
    let marPath = JSON.parse(fs.readFileSync(saved, "utf8"));
    if (marPath && fs.existsSync(marPath)) {
      return marPath;
    }
  }
  let fallback = path.join(DIST, "output.mar");
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  return fail("No update package found. Run `npx surfer package` first.");
}

if (!fs.existsSync(path.join(KEYS, "key4.db"))) {
  fail(
    `The update signing key isn't in ${KEYS}.\n` +
      "Restore it from your backup before preparing a release."
  );
}

let signmar = path.join(OBJ, "dist", "bin", "signmar.exe");
if (!fs.existsSync(signmar)) {
  fail("signmar.exe isn't built. Run `npx surfer build` first.");
}
// signmar needs the NSS libraries next to it.
let env = {
  ...process.env,
  PATH: `${path.dirname(signmar)}${path.delimiter}${process.env.PATH}`,
};

let mar = findMar();
let signed = path.join(DIST, "windows.mar");
fs.mkdirSync(DIST, { recursive: true });
fs.rmSync(signed, { force: true });

console.log(`Signing ${path.relative(ROOT, mar)}...`);
run(
  signmar,
  [
    "-d",
    `sql:${KEYS}`,
    "-n",
    "pufferfish-update-primary",
    "-s",
    mar,
    signed,
  ],
  { env }
);
console.log("Checking the signature against Pufferfish's certificate...");
run(signmar, ["-D", CERT, "-v", signed], { env });

// surfer reads the package path from its saved config, so point it at the
// signed copy: the checksum in update.xml must match the file users download.
fs.writeFileSync(
  path.join(ROOT, ".surfer", "dynamicConfig.marPath.json"),
  JSON.stringify(signed)
);

console.log("Writing update.xml...");
run("npx", ["surfer", "updates-browser"], { cwd: ROOT, shell: true });

let generated = path.join(DIST, "update", "browser");
if (!fs.existsSync(generated)) {
  fail(`surfer didn't write ${generated}.`);
}
if (!fs.existsSync(UPDATES_DIR)) {
  fail(`The update site folder ${UPDATES_DIR} doesn't exist.`);
}
let target = path.join(UPDATES_DIR, "updates", "browser");
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(generated, target, { recursive: true });

let surfer = JSON.parse(fs.readFileSync(path.join(ROOT, "surfer.json")));
let version = surfer.brands.pufferfish.release.displayVersion;
let repo = surfer.brands.pufferfish.release.github.repo;

console.log(`
Update files for Pufferfish ${version} are ready.

1. On https://github.com/${repo}/releases create the release "${version}"
   (tag ${version}) and attach:
     dist/windows.mar   (the name must stay windows.mar)
     the installer from dist/
2. Then publish update.xml, so existing copies of Pufferfish find the release:
     cd ${UPDATES_DIR}
     wrangler deploy

Publish update.xml only after the release's files are uploaded, or update
checks will find an update they can't download.
`);
