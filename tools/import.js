// `npm.cmd run import`: applies the patches with `surfer import`, then always
// runs fix-branding.js, even when surfer exits with an error. surfer rewrites
// the branding (with Zen Browser's website in it) on every import, so skipping
// the fix would make Pufferfish open Zen's pages.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");

const surfer = spawnSync("npx surfer import", {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

const fix = spawnSync(process.execPath, [path.join(__dirname, "fix-branding.js")], {
  cwd: root,
  stdio: "inherit",
});

if (surfer.status !== 0) {
  console.error(
    `\nsurfer import exited with code ${surfer.status}. Branding was still fixed, ` +
      "but check the output above for patches that failed to apply."
  );
}
process.exit(surfer.status || fix.status || 0);
