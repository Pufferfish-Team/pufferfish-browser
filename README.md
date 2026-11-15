# Pufferfish

Pufferfish is a web browser built on Firefox. Its headline feature is the
**Puff Dock**: your tabs as live page previews in a dock that slides out from
the edge of the window, with pinned tabs, tab groups and drag and drop. A
full-screen view shows every tab at once.

Website: <https://www.pufferfishbrowser.com>

> Pufferfish is an independent project. It is based on Mozilla Firefox but is
> not made, endorsed or supported by Mozilla. Firefox is a trademark of the
> Mozilla Foundation.

## What's different from Firefox

- **Puff Dock** and a full-screen tab view in place of the tab strip, with
  their own page in Settings.
- **DuckDuckGo** is the default search engine, and Mozilla's search partner
  codes are removed from every engine.
- **No telemetry, studies or experiments.** Data reporting, Normandy and
  Nimbus are off, and crash reports are not sent to Mozilla.
- **No sponsored content** on the new tab page or in the address bar, and no
  promotions for Mozilla's products.
- **No Mozilla onboarding.** Firefox's welcome screens and pop-up tips are off.

Mozilla's free services that are part of how the browser works stay as they
are, under Mozilla's names: Sync with a Mozilla account, the add-ons site,
Safe Browsing lists and settings updates.

## How this repository works

Pufferfish is built with [surfer](https://github.com/zen-browser/surfer). The
repository doesn't contain Firefox itself, only Pufferfish's changes to it:

| Folder | Contents |
|---|---|
| `src/` | Changes to Firefox. `.patch` files are applied to Firefox's files; every other file is copied into the Firefox source as is (for example the Puff Dock code). |
| `configs/` | Build settings (`mozconfig`) and the branding artwork. |
| `tools/` | Helper scripts used by the commands below. |
| `surfer.json` | The Firefox version Pufferfish is based on, and the brand settings. |

Firefox's source is downloaded into `engine/`, which git ignores.

## Building

Pufferfish is developed and built on Windows 10 or 11 (64-bit). Building
Firefox needs a fast machine: plan for 40 GB of free disk space, 16 GB of
memory or more, and an hour or more for the first build.

You need:

- [Git for Windows](https://gitforwindows.org/) (the commands below are run
  from Git Bash)
- [Node.js](https://nodejs.org/) 20 or newer
- [MozillaBuild](https://wiki.mozilla.org/MozillaBuild) and the Visual Studio
  build tools, as described in Mozilla's
  [Windows build guide](https://firefox-source-docs.mozilla.org/setup/windows_build.html)

Then, from the repository folder:

```bash
npm install
npx surfer download     # download the Firefox source into engine/
npm run import          # apply Pufferfish's changes and branding
npx surfer bootstrap    # first time only: install the build toolchain
npx surfer build
npx surfer run
```

Use `npm run import` rather than `npx surfer import`: it also runs
`tools/fix-branding.js`, which removes the website links surfer adds to the
branding.

### API keys (optional)

Safe Browsing ("Block dangerous and deceptive content") needs a Google Safe
Browsing API key. Put it in `configs/keys/google-safebrowsing.key` before
building. That folder is ignored by git, so the key is never committed.
Without a key, Pufferfish builds and runs normally with Safe Browsing lists
turned off.

### Making changes

Edit the files in `engine/`, then save the change back to `src/` as a patch:

```bash
npx surfer export browser/path/to/the/file.js
```

Files that are new in Pufferfish (not changes to a Firefox file) live directly
in `src/`; copy them back there after editing them in `engine/`.

## Releasing

Pufferfish updates itself with Firefox's built-in updater. Each copy checks
`https://updates.pufferfishbrowser.com/updates/browser/<platform>/pufferfish/update.xml`
and only installs update packages signed with the Pufferfish update key. The
public certificates are in `src/toolkit/mozapps/update/updater/`; the private
key lives in `configs/keys/update-signing/`, which git ignores, and is
backed up outside this machine.

To make a release:

1. Raise `displayVersion` in `surfer.json`.
2. Build and package:

   ```bash
   npx surfer build
   npm run package
   ```

3. Sign the update package and write `update.xml`:

   ```bash
   npm run prepare-update
   ```

4. Create the GitHub release named after the version, with `dist/windows.mar`
   and the installer attached.
5. Deploy the update site (`wrangler deploy` in the update site folder) so
   existing copies find the new version.

To move to a newer Firefox, run `npx surfer update`, then `npm run import`,
and fix any patches that no longer apply.

## License

Pufferfish is free software under the [Mozilla Public License 2.0](LICENSE),
the same license as Firefox. Firefox's own source code is © Mozilla and its
contributors.

The Pufferfish name and logo are not covered by the code license. Forks should
use their own name and artwork.
