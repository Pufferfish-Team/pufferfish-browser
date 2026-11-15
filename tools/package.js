// Packages Pufferfish for release:
//
//   npm run package
//
// Runs `surfer package`, which builds the installer. surfer then tries to
// build the update package itself, which always fails: it calls Mozilla's
// packaging script with the arguments it took before Firefox 160 (and needs
// bash on the PATH). `npm run prepare-update` builds the update package
// instead, so that one failure is expected; anything else is a real error.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const INSTALLER = path.join(DIST, "pufferfish-browser.installer.exe");

let started = Date.now();
// Show surfer's output as it runs, and keep a copy to check how it ended.
let output = "";
let child = spawn("npx surfer package", { cwd: ROOT, shell: true });
for (let [stream, target] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.on("data", chunk => {
    output += chunk;
    target.write(chunk);
  });
}
child.on("close", status => finish(status));

function finish(status) {
  let installerIsNew =
    fs.existsSync(INSTALLER) && fs.statSync(INSTALLER).mtimeMs >= started;
  let onlyMarFailed =
    status === 0 || /output\.mar'/.test(output.split("Creating mar file")[1] || "");

  if (!installerIsNew || !onlyMarFailed) {
    console.error("\nPackaging failed. See the output above.");
    process.exit(1);
  }

  // surfer's update.xml folder from the failed step is never used.
  fs.rmSync(path.join(DIST, "update"), { recursive: true, force: true });

  console.log(`
Packaging succeeded. (The "output.mar" error above is expected: surfer's
update package step doesn't work with Firefox 160.)

Installer: ${path.relative(ROOT, INSTALLER)}
Next, to build and sign the update package: npm run prepare-update
`);
}
