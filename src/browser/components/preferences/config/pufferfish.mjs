/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Settings > Pufferfish: settings for Pufferfish's own features. New
 * Pufferfish features get their settings group here, and the group's id is
 * added to the "pufferfish" pane's groupIds in preferences.js.
 */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

/* Puff Dock */

Preferences.addAll([
  { id: "pufferfish.tabs.dock.enabled", type: "bool" },
  { id: "pufferfish.tabs.dock.position", type: "string" },
  { id: "pufferfish.tabs.dock.showMuteButton", type: "bool" },
  { id: "pufferfish.tabs.dock.showCloseButton", type: "bool" },
  { id: "pufferfish.tabs.dock.magnify", type: "bool" },
  { id: "pufferfish.tabs.dock.reduceMotion", type: "bool" },
]);

Preferences.addSetting({
  id: "puffDockEnabled",
  pref: "pufferfish.tabs.dock.enabled",
});

// The other dock settings are greyed out while the dock is turned off.
for (let [id, pref] of [
  ["puffDockPosition", "pufferfish.tabs.dock.position"],
  ["puffDockMuteButton", "pufferfish.tabs.dock.showMuteButton"],
  ["puffDockCloseButton", "pufferfish.tabs.dock.showCloseButton"],
  ["puffDockMagnify", "pufferfish.tabs.dock.magnify"],
  ["puffDockReduceMotion", "pufferfish.tabs.dock.reduceMotion"],
]) {
  Preferences.addSetting({
    id,
    pref,
    deps: ["puffDockEnabled"],
    disabled: ({ puffDockEnabled }) => !puffDockEnabled.value,
  });
}

Preferences.addSetting({ id: "puffDockHelp" });

SettingGroupManager.registerGroups({
  puffDock: {
    l10nId: "puff-dock-group-header",
    iconSrc: "chrome://browser/skin/tabs.svg",
    headingLevel: 2,
    items: [
      {
        id: "puffDockEnabled",
        l10nId: "puff-dock-enabled",
      },
      {
        id: "puffDockPosition",
        control: "moz-radio-group",
        l10nId: "puff-dock-position",
        options: [
          { id: "puffDockTop", value: "top", l10nId: "puff-dock-position-top" },
          {
            id: "puffDockBottom",
            value: "bottom",
            l10nId: "puff-dock-position-bottom",
          },
        ],
      },
      {
        id: "puffDockMuteButton",
        l10nId: "puff-dock-mute-button",
      },
      {
        id: "puffDockCloseButton",
        l10nId: "puff-dock-close-button",
      },
      {
        id: "puffDockMagnify",
        l10nId: "puff-dock-magnify",
      },
      {
        id: "puffDockReduceMotion",
        l10nId: "puff-dock-reduce-motion",
      },
      {
        // Pufferfish's own features link to Pufferfish's site for help, not
        // Mozilla's support site.
        id: "puffDockHelp",
        l10nId: "puff-dock-help",
        control: "moz-box-link",
        controlAttrs: {
          href: "https://www.pufferfishbrowser.com/",
        },
      },
    ],
  },
});
