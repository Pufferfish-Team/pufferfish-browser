// Prepares a Pufferfish release's update files, after `npm run package`:
//
//   npm run prepare-update
//
// 1. Builds the update package (a .mar file) from the packaged browser in
//    engine/obj-x86_64-pc-windows-msvc/dist/pufferfish-browser. surfer's own
//    step for this calls Mozilla's packaging script with the arguments it
//    took before Firefox 160, so it no longer works.
// 2. Signs it with the Pufferfish update key in configs/keys/update-signing,
//    and checks the signature against the certificate built into Pufferfish.
//    Pufferfish refuses unsigned updates.
// 3. Saves it as dist/windows.mar, the name the GitHub release must use.
// 4. Writes update.xml, with the signed package's size, checksum and GitHub
//    download address, into the update site folder (../PufferfishUpdates,
//    or the PUFFERFISH_UPDATES_DIR environment variable).
//
// It doesn't upload or deploy anything. The steps for that are printed at the
// end.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const ENGINE = path.join(ROOT, "engine");
const OBJ = path.join(ENGINE, "obj-x86_64-pc-windows-msvc");
const KEYS = path.join(ROOT, "configs", "keys", "update-signing");
const CERT = path.join(
  ENGINE,
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
// The packaged browser. PUFFERFISH_STAGE_DIR overrides it for testing.
const STAGE =
  process.env.PUFFERFISH_STAGE_DIR ||
  path.join(OBJ, "dist", "pufferfish-browser");
const CHANNEL = "pufferfish";

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

// Git Bash wants /c/... paths.
function unixPath(p) {
  return p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}

function findBash() {
  for (let candidate of [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    "C:\\mozilla-build\\msys2\\usr\\bin\\bash.exe",
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return fail("Git Bash wasn't found. Install Git for Windows.");
}

let surfer = JSON.parse(fs.readFileSync(path.join(ROOT, "surfer.json")));
let version = surfer.brands.pufferfish.release.displayVersion;
let repo = surfer.brands.pufferfish.release.github.repo;

if (!fs.existsSync(path.join(KEYS, "key4.db"))) {
  fail(
    `The update signing key isn't in ${KEYS}.\n` +
      "Restore it from your backup before preparing a release."
  );
}

let appIni = path.join(STAGE, "application.ini");
if (!fs.existsSync(appIni)) {
  fail(`${STAGE} doesn't exist. Run \`npx surfer package\` first.`);
}
let builtVersion = /^Version=(.*)$/m.exec(fs.readFileSync(appIni, "utf8"))?.[1];
if (builtVersion?.trim() != version) {
  fail(
    `The packaged browser is version ${builtVersion}, but surfer.json says ` +
      `${version}.\nRebuild and package after changing displayVersion.`
  );
}

let binDir = path.join(OBJ, "dist", "bin");
let hostBin = path.join(OBJ, "dist", "host", "bin");
let signmar = path.join(binDir, "signmar.exe");
let mar = path.join(hostBin, "mar.exe");
for (let tool of [signmar, mar]) {
  if (!fs.existsSync(tool)) {
    fail(`${path.basename(tool)} isn't built. Run \`npx surfer build\` first.`);
  }
}
// signmar needs the NSS libraries next to it.
let env = {
  ...process.env,
  PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
};

fs.mkdirSync(DIST, { recursive: true });
let unsigned = path.join(DIST, "unsigned.mar");
let signed = path.join(DIST, "windows.mar");
fs.rmSync(unsigned, { force: true });
fs.rmSync(signed, { force: true });

console.log(`Building the update package for Pufferfish ${version}...`);
run(
  findBash(),
  [
    unixPath(path.join(ENGINE, "tools", "update-packaging", "make_full_update.sh")),
    "-q",
    unixPath(unsigned),
    unixPath(STAGE),
    "pufferfish-browser",
  ],
  {
    env: {
      ...process.env,
      MAR: unixPath(mar),
      MOZ_PRODUCT_VERSION: version,
      MAR_CHANNEL_ID: CHANNEL,
    },
  }
);
// The packaging script leaves a work folder next to the packaged browser.
fs.rmSync(`${STAGE}.work`, { recursive: true, force: true });

console.log("Signing it...");
run(
  signmar,
  ["-d", `sql:${KEYS}`, "-n", "pufferfish-update-primary", "-s", unsigned, signed],
  { env }
);
fs.rmSync(unsigned, { force: true });
console.log("Checking the signature against Pufferfish's certificate...");
run(signmar, ["-D", CERT, "-v", signed], { env });

// update.xml tells Pufferfish about the new version: where to download it,
// and its size and checksum, which must match the signed file exactly.
// (surfer's `updates-browser` writes "undefined" in place of the file name
// unless it runs inside a surfer build, so this writes the file itself.)
console.log("Writing update.xml...");
let platformIni = fs.readFileSync(path.join(STAGE, "platform.ini"), "utf8");
let buildID = /^BuildID=(.*)$/m.exec(platformIni)[1].trim();
let platformVersion = /^Milestone=(.*)$/m.exec(platformIni)[1].trim();
let hash = require("node:crypto")
  .createHash("sha512")
  .update(fs.readFileSync(signed))
  .digest("hex");
let url = `https://github.com/${repo}/releases/download/${version}/windows.mar`;
let updateXml = `<?xml version="1.0"?>
<updates>
  <update type="minor" displayVersion="${version}" appVersion="${version}" platformVersion="${platformVersion}" buildID="${buildID}">
    <patch type="complete" URL="${url}" hashFunction="sha512" hashValue="${hash}" size="${fs.statSync(signed).size}"/>
  </update>
</updates>
`;

if (!fs.existsSync(UPDATES_DIR)) {
  fail(`The update site folder ${UPDATES_DIR} doesn't exist.`);
}
// Firefox asks for one of these two names on 64-bit Windows.
for (let target of ["WINNT_x86_64-msvc", "WINNT_x86_64-msvc-x64"]) {
  let dir = path.join(UPDATES_DIR, "updates", "browser", target, CHANNEL);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "update.xml"), updateXml);
}

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
