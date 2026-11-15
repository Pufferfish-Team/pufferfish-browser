/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Pufferfish Puff Dock.
 *
 * A small handle sits just under the address bar (or at the bottom of the
 * window). Hovering it slides out a dock of tab thumbnails that floats over
 * the page. Thumbnails near the mouse grow, like the macOS Dock.
 *
 * The dock also has a full-screen view: a searchable grid of every tab that
 * covers the page area. It opens from the grid button at the end of the dock,
 * the toolbar button, Ctrl+Shift+A, or Ctrl+Shift+Tab.
 *
 * Each thumbnail has a mute button in its top-left corner and a close button
 * in its top-right corner, shown on hover. The mute button stays visible on
 * tabs that are playing sound or muted.
 *
 * Sleeping tabs (unloaded to save memory, or not yet restored) are shown
 * faded with a moon badge; tabs that are loading get a spinner badge.
 *
 * Pinned tabs are small icons in a column at the start of the dock. Tab
 * groups (Firefox's own) are boxes in the group's colour with the name above;
 * clicking the name folds the group into a stack. Thumbnails can be dragged
 * to reorder them, into or out of a group, into the pinned column, or onto
 * the page to open the tab in a new window. Right-clicking one opens
 * Firefox's tab menu. The full-screen view shows pinned tabs first and each
 * group as its own section.
 *
 * Prefs (all in Settings > Tabs & browsing > Puff Dock):
 *   pufferfish.tabs.dock.enabled          (bool)   show the handle and dock
 *   pufferfish.tabs.dock.position         (string) "top" or "bottom"
 *   pufferfish.tabs.dock.showMuteButton   (bool)   mute button on thumbnails
 *   pufferfish.tabs.dock.showCloseButton  (bool)   close button on thumbnails
 *   pufferfish.tabs.dock.magnify          (bool)   grow thumbnails near the
 *                                                  mouse
 *   pufferfish.tabs.dock.reduceMotion     (bool)   no slide or zoom
 *                                                  animations; also on when
 *                                                  the OS asks for less motion
 */
var PufferfishTabDock = {
  PREF_ENABLED: "pufferfish.tabs.dock.enabled",
  PREF_POSITION: "pufferfish.tabs.dock.position",
  PREF_MUTE_BUTTON: "pufferfish.tabs.dock.showMuteButton",
  PREF_CLOSE_BUTTON: "pufferfish.tabs.dock.showCloseButton",
  PREF_MAGNIFY: "pufferfish.tabs.dock.magnify",
  PREF_REDUCE_MOTION: "pufferfish.tabs.dock.reduceMotion",
  AUDIO_ATTRIBUTES: ["soundplaying", "muted", "activemedia-blocked"],
  STATE_ATTRIBUTES: ["busy", "pending", "discarded"],
  WIDGET_ID: "pufferfish-tab-overview-button",

  OPEN_DELAY_MS: 120,
  CLOSE_DELAY_MS: 250,
  // Thumbnails are only captured once the slide-out animation has finished,
  // so the capture work never competes with it.
  ANIMATION_MS: 240,
  // How long a tab must stay selected and idle before its thumbnail is taken
  // in the background.
  BACKGROUND_CAPTURE_MS: 1000,
  BASE_WIDTH: 112,
  MIN_WIDTH: 44,
  MAX_SCALE: 1.6,
  INFLUENCE_PX: 150,
  GAP: 8,
  // The "+" and grid buttons at the end of the dock.
  END_BUTTONS_WIDTH: 88,
  // Canvas size in CSS pixels; big enough for a card in the full-screen view.
  THUMB_W: 320,
  THUMB_H: 200,

  HTML_NS: "http://www.w3.org/1999/xhtml",

  _container: null,
  _zone: null,
  _handle: null,
  _dock: null,
  _items: [],
  _isOpen: false,
  _openTimer: 0,
  _closeTimer: 0,
  _renderQueued: false,
  _prepared: false,
  _captureTimer: 0,
  _backgroundTimer: 0,
  _magnifyFrame: 0,
  _generation: 0,
  _thumbCache: new WeakMap(),

  _overview: null,
  _overviewInput: null,
  _overviewCount: null,
  _overviewGrid: null,
  _cards: [],
  _overviewOpen: false,
  _keyIndex: 0,

  get _PageThumbs() {
    delete this._PageThumbs;
    return (this._PageThumbs = ChromeUtils.importESModule(
      "resource://gre/modules/PageThumbs.sys.mjs"
    ).PageThumbs);
  },

  get enabled() {
    return !!this._container && !this._container.hidden;
  },

  init() {
    if (this._container) {
      return;
    }
    let root = document.documentElement;
    let isSingleTabWindow =
      !window.toolbar.visible ||
      root.hasAttribute("taskbartab") ||
      root.hasAttribute("mini-window");
    let browserBox = document.getElementById("browser");
    if (isSingleTabWindow || !browserBox) {
      return;
    }

    this._buildDOM(browserBox);
    this._buildOverview();
    this._applyPrefs();
    this._createToolbarButton();
    this._hookShortcuts();
    this._hookGroupEditor();

    this._onPrefChange = () => this._applyPrefs();
    for (let pref of this._prefs()) {
      Services.prefs.addObserver(pref, this._onPrefChange);
    }

    // Keep mute buttons and sleeping/loading badges in step with the tabs.
    this._onTabAttrModified = event => {
      let changed = event.detail?.changed ?? [];
      if (changed.some(a => this.AUDIO_ATTRIBUTES.includes(a))) {
        this._updateAudioButtons(event.target);
      }
      if (changed.some(a => this.STATE_ATTRIBUTES.includes(a))) {
        this._updateTabState(event.target);
      }
    };
    gBrowser.tabContainer.addEventListener(
      "TabAttrModified",
      this._onTabAttrModified
    );
    // Tabs going to sleep or waking up don't always send TabAttrModified.
    this._onTabSleepChange = event => this._updateTabState(event.target);
    for (let type of ["TabBrowserDiscarded", "TabBrowserInserted"]) {
      gBrowser.tabContainer.addEventListener(type, this._onTabSleepChange);
    }

    this._onTabEvent = event => {
      this._prepared = false;
      this._queueRender();
      if (event.type == "TabSelect") {
        this._scheduleBackgroundCapture();
      }
    };
    for (let type of [
      "TabOpen",
      "TabClose",
      "TabSelect",
      "TabMove",
      "TabPinned",
      "TabUnpinned",
      "TabGrouped",
      "TabUngrouped",
      "TabGroupCreate",
      "TabGroupRemoved",
      "TabGroupCollapse",
      "TabGroupExpand",
      "TabGroupUpdate",
    ]) {
      gBrowser.tabContainer.addEventListener(type, this._onTabEvent);
    }

    // Re-take the current tab's thumbnail after each page finishes loading.
    this._progressListener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onStateChange: (webProgress, request, flags) => {
        if (
          webProgress.isTopLevel &&
          flags & Ci.nsIWebProgressListener.STATE_STOP &&
          flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW
        ) {
          this._scheduleBackgroundCapture();
        }
      },
    };
    gBrowser.addProgressListener(this._progressListener);

    // Load the thumbnail code now, while the browser is idle, rather than on
    // the first hover.
    requestIdleCallback(() => this._PageThumbs);
    this._scheduleBackgroundCapture();

    window.addEventListener("unload", () => this.uninit(), { once: true });
  },

  _prefs() {
    return [
      this.PREF_ENABLED,
      this.PREF_POSITION,
      this.PREF_MUTE_BUTTON,
      this.PREF_CLOSE_BUTTON,
      this.PREF_MAGNIFY,
      this.PREF_REDUCE_MOTION,
    ];
  },

  // True when the dock should skip its animations: the Puff Dock setting, or
  // the OS setting for less motion.
  get _reduceMotion() {
    return (
      Services.prefs.getBoolPref(this.PREF_REDUCE_MOTION, false) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  },

  uninit() {
    for (let pref of this._prefs()) {
      Services.prefs.removeObserver(pref, this._onPrefChange);
    }
    gBrowser.removeProgressListener(this._progressListener);
    this._unhookGroupEditor?.();
    clearTimeout(this._openTimer);
    clearTimeout(this._closeTimer);
    clearTimeout(this._captureTimer);
    clearTimeout(this._backgroundTimer);
  },

  _el(tag, className) {
    let el = document.createElementNS(this.HTML_NS, tag);
    if (className) {
      el.className = className;
    }
    return el;
  },

  _buildDOM(browserBox) {
    // Full-size, click-through layer over the page area. It clips the dock
    // so it appears to slide out from under the toolbar.
    let container = this._el("div");
    container.id = "pufferfish-tab-dock-container";

    let zone = this._el("div", "pf-dock-zone");

    let handle = this._el("div", "pf-dock-handle");
    handle.setAttribute("role", "button");
    handle.setAttribute("aria-label", "Show tabs");
    handle.appendChild(this._el("div", "pf-dock-handle-grip"));

    let dock = this._el("div", "pf-dock");
    dock.setAttribute("role", "tablist");
    dock.setAttribute("aria-label", "Open tabs");

    zone.append(handle, dock);
    container.appendChild(zone);
    browserBox.appendChild(container);

    this._container = container;
    this._zone = zone;
    this._handle = handle;
    this._dock = dock;

    zone.addEventListener("mouseenter", () => this._onZoneEnter());
    zone.addEventListener("mouseleave", () => this._onZoneLeave());
    handle.addEventListener("click", () => this.open());
    // Mouse moves can arrive several times per frame; resize the items at
    // most once per frame.
    dock.addEventListener("mousemove", e => {
      this._mouseX = e.clientX;
      if (!this._magnifyFrame) {
        this._magnifyFrame = requestAnimationFrame(() => {
          this._magnifyFrame = 0;
          // No magnifying while dragging: the thumbnails would shift under
          // the dragged tab.
          if (this._isOpen && this._magnifyEnabled && !this._drag?.started) {
            this._magnify(this._mouseX);
          }
        });
      }
    });
    dock.addEventListener("mouseleave", () => this._resetMagnify());
    dock.addEventListener("click", e => this._onDockClick(e));
    dock.addEventListener("auxclick", e => this._onDockAuxClick(e));
    dock.addEventListener("contextmenu", e => this._onContextMenu(e));
    dock.addEventListener("mousedown", e => {
      // Keep a middle-click from starting autoscroll.
      if (e.button == 1) {
        e.preventDefault();
      }
      this._onDockMouseDown(e);
    });
    dock.addEventListener(
      "wheel",
      e => {
        if (dock.scrollWidth > dock.clientWidth) {
          dock.scrollLeft += e.deltaY || e.deltaX;
          e.preventDefault();
        }
      },
      { passive: false }
    );
    this._onKeyDown = e => {
      // Escape during a drag cancels the drag, not the dock. While the group
      // panel is open, Escape belongs to the panel.
      if (
        e.key == "Escape" &&
        this._isOpen &&
        !this._drag?.started &&
        !this._editorOpen
      ) {
        e.preventDefault();
        this.close();
      }
    };
  },

  _applyPrefs() {
    let enabled = Services.prefs.getBoolPref(this.PREF_ENABLED, true);
    let position = Services.prefs.getStringPref(this.PREF_POSITION, "top");
    if (position != "bottom") {
      position = "top";
    }
    this._container.hidden = !enabled;
    this._container.setAttribute("position", position);
    this._container.toggleAttribute(
      "hide-mute",
      !Services.prefs.getBoolPref(this.PREF_MUTE_BUTTON, true)
    );
    this._container.toggleAttribute(
      "hide-close",
      !Services.prefs.getBoolPref(this.PREF_CLOSE_BUTTON, true)
    );
    this._container.toggleAttribute(
      "reduce-motion",
      Services.prefs.getBoolPref(this.PREF_REDUCE_MOTION, false)
    );
    this._magnifyEnabled = Services.prefs.getBoolPref(this.PREF_MAGNIFY, true);
    if (!this._magnifyEnabled) {
      this._resetMagnify();
    }
    if (!enabled) {
      this.close();
      this.closeOverview();
    }
  },

  /* Opening and closing the dock */

  _onZoneEnter() {
    clearTimeout(this._closeTimer);
    if (!this._isOpen && !this._overviewOpen) {
      // Build the dock now, while it is still hidden, so the open delay
      // absorbs that work and the slide-out starts on a quiet frame.
      this._prepare();
      clearTimeout(this._openTimer);
      this._openTimer = setTimeout(() => this.open(), this.OPEN_DELAY_MS);
    }
  },

  _prepare() {
    if (!this._prepared) {
      this._render();
      this._prepared = true;
    }
  },

  _onZoneLeave() {
    // Stay open while a tab is being dragged (it may be dragged out to open a
    // new window), its right-click menu is showing, or the group panel is
    // pointing at it.
    if (this._drag?.started || this._menuOpen || this._editorOpen) {
      return;
    }
    clearTimeout(this._openTimer);
    if (!this._isOpen) {
      // Titles or pages may change before the next hover; rebuild then.
      this._prepared = false;
    }
    if (this._isOpen) {
      clearTimeout(this._closeTimer);
      this._closeTimer = setTimeout(() => this.close(), this.CLOSE_DELAY_MS);
    }
  },

  open() {
    if (this._isOpen || this._overviewOpen || !this.enabled) {
      return;
    }
    this._isOpen = true;
    this._prepare();
    this._container.setAttribute("open", "true");
    window.addEventListener("keydown", this._onKeyDown, true);
    this._captureAfterAnimation(
      this._items.map(i => i._tab),
      tab => this._items.find(i => i._tab == tab)?.querySelector(".pf-dock-thumb")
    );
  },

  close() {
    clearTimeout(this._openTimer);
    clearTimeout(this._closeTimer);
    clearTimeout(this._captureTimer);
    if (!this._isOpen) {
      return;
    }
    this._isOpen = false;
    this._prepared = false;
    this._generation++;
    this._container.removeAttribute("open");
    this._resetMagnify();
    window.removeEventListener("keydown", this._onKeyDown, true);
  },

  /* Rendering the dock */

  _queueRender() {
    if ((!this._isOpen && !this._overviewOpen) || this._renderQueued) {
      return;
    }
    // Rebuilding mid-drag would pull the dragged thumbnail out from under the
    // mouse; the drag re-renders when it ends.
    if (this._drag?.started) {
      return;
    }
    // Likewise while the group panel points at a group label; the panel
    // closes if its label is rebuilt. It re-renders when the panel closes.
    if (this._editorOpen) {
      this._renderAfterEditor = true;
      return;
    }
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      // The group panel may have opened since this render was queued.
      if (this._editorOpen) {
        this._renderAfterEditor = true;
        return;
      }
      if (this._isOpen) {
        this._render();
        this._prepared = true;
        this._captureThumbnails(
          this._items.map(i => i._tab),
          this._generation,
          tab =>
            this._items
              .find(i => i._tab == tab)
              ?.querySelector(".pf-dock-thumb")
        );
      } else if (this._overviewOpen) {
        this._renderOverview();
      }
    });
  },

  // Every tab the dock shows, in tab strip order. Unlike gBrowser.visibleTabs
  // this includes tabs inside folded groups; it leaves out tabs hidden by
  // extensions.
  _allTabs() {
    return gBrowser.tabs.filter(tab => !tab.hidden && !tab.closing);
  },

  // Splits the unpinned tabs into runs: a single ungrouped tab, or all the
  // tabs of one group.
  _runs(tabs) {
    let runs = [];
    for (let tab of tabs) {
      let group = tab.group ?? null;
      let last = runs.at(-1);
      if (group && last?.group == group) {
        last.tabs.push(tab);
      } else {
        runs.push({ group, tabs: [tab] });
      }
    }
    return runs;
  },

  // Group colours come from Firefox's own tab group palette.
  _setGroupColor(element, group) {
    element.style.setProperty("--pf-group", `var(--tab-group-${group.color})`);
    element.style.setProperty(
      "--pf-group-pale",
      `var(--tab-group-${group.color}-pale)`
    );
  },

  _groupName(group) {
    return group.label || "Unnamed group";
  },

  // Builds the dock's items. Thumbnail captures are started separately, so
  // this can run while the dock is still hidden.
  _render() {
    ++this._generation;
    let all = this._allTabs();
    let pinned = all.filter(tab => tab.pinned);
    let runs = this._runs(all.filter(tab => !tab.pinned));
    let dock = this._dock;
    dock.textContent = "";
    this._items = [];
    this._centersStale = true;

    // A folded group takes the room of one thumbnail.
    let slots = runs.reduce(
      (n, run) => n + (run.group?.collapsed ? 1 : run.tabs.length),
      0
    );
    let groupCount = runs.filter(run => run.group).length;
    let pinsWidth = pinned.length ? Math.ceil(pinned.length / 2) * 34 + 12 : 0;
    let available =
      this._container.clientWidth -
      64 -
      this.END_BUTTONS_WIDTH -
      pinsWidth -
      groupCount * 14 -
      this.GAP * (slots + 2);
    let base = Math.max(
      this.MIN_WIDTH,
      Math.min(this.BASE_WIDTH, Math.floor(available / Math.max(1, slots)))
    );
    this._baseWidth = base;
    dock.toggleAttribute("has-groups", groupCount > 0);

    // Pinned tabs: small icons in a column at the start. The column is always
    // there (empty and hidden) so it can take a drop while dragging.
    let pins = this._el("div", "pf-dock-pins");
    for (let tab of pinned) {
      pins.appendChild(this._createPin(tab));
    }
    dock.appendChild(pins);
    this._pins = pins;

    for (let run of runs) {
      if (!run.group) {
        let item = this._createItem(run.tabs[0], base);
        dock.appendChild(item);
        this._items.push(item);
        continue;
      }
      let box = this._el("div", "pf-dock-group");
      box._group = run.group;
      box.toggleAttribute("collapsed", run.group.collapsed);
      this._setGroupColor(box, run.group);

      let label = this._el("div", "pf-dock-group-label");
      label.textContent = this._groupName(run.group);
      label.title = run.group.collapsed
        ? "Click to show this group's tabs"
        : "Click to fold this group";
      box.appendChild(label);

      if (run.group.collapsed) {
        box.appendChild(this._createDeck(run, base));
      } else {
        for (let tab of run.tabs) {
          let item = this._createItem(tab, base);
          box.appendChild(item);
          this._items.push(item);
        }
      }
      dock.appendChild(box);
    }

    let newTab = this._el("div", "pf-dock-button pf-dock-newtab");
    newTab.setAttribute("role", "button");
    newTab.setAttribute("aria-label", "New tab");
    newTab.title = "New tab";
    newTab.textContent = "+";

    let showAll = this._el("div", "pf-dock-button pf-dock-showall");
    showAll.setAttribute("role", "button");
    showAll.setAttribute("aria-label", "Show all tabs");
    showAll.title = "Show all tabs (Ctrl+Shift+A)";

    dock.append(newTab, showAll);
  },

  _createItem(tab, width) {
    let item = this._el("div", "pf-dock-item");
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", tab.selected ? "true" : "false");
    item.setAttribute("aria-label", tab.label);
    item.toggleAttribute("selected", tab.selected);
    item.style.width = width + "px";
    item._tab = tab;

    let label = this._el("div", "pf-dock-label");
    label.append(...this._iconAndTitle(tab));

    item.append(this._createThumbWithButtons(tab), label);
    return item;
  },

  // A pinned tab: just its icon, with the title as a tooltip.
  _createPin(tab) {
    let pin = this._el("div", "pf-dock-pin");
    pin.setAttribute("role", "tab");
    pin.setAttribute("aria-selected", tab.selected ? "true" : "false");
    pin.setAttribute("aria-label", tab.label);
    pin.toggleAttribute("selected", tab.selected);
    pin.toggleAttribute("sleeping", this._isSleeping(tab));
    pin.title = tab.label;
    pin._tab = tab;
    let iconURL = gBrowser.getIcon(tab);
    if (iconURL) {
      let img = this._el("img");
      img.src = iconURL;
      pin.appendChild(img);
    } else {
      pin.textContent = (tab.label || "?").charAt(0).toUpperCase();
    }
    return pin;
  },

  // A folded group: a small stack of cards showing how many tabs it holds.
  _createDeck(run, width) {
    let deck = this._el("div", "pf-dock-deck");
    deck.style.width = width + "px";
    deck._group = run.group;
    deck.setAttribute("role", "button");
    let count = run.tabs.length;
    deck.setAttribute(
      "aria-label",
      `${this._groupName(run.group)}, ${count} ${count == 1 ? "tab" : "tabs"}`
    );
    deck.title = "Click to show this group's tabs";
    deck.toggleAttribute(
      "selected",
      run.tabs.some(tab => tab.selected)
    );
    for (let i = 0; i < 2; i++) {
      deck.appendChild(this._el("div", "pf-dock-deck-card pf-dock-deck-back"));
    }
    let front = this._el("div", "pf-dock-deck-card pf-dock-thumb");
    this._fillThumb(front, run.tabs[0]);
    let badge = this._el("div", "pf-dock-deck-count");
    badge.textContent = count;
    deck.append(front, badge);
    return deck;
  },

  // The thumbnail plus its mute (top-left) and close (top-right) buttons.
  _createThumbWithButtons(tab) {
    let wrap = this._el("div", "pf-thumb-wrap");
    wrap._tab = tab;
    this._setTabState(wrap, tab);

    let thumb = this._el("div", "pf-dock-thumb");
    this._fillThumb(thumb, tab);

    // Sleeping (moon) or loading (spinner) badge, bottom-right.
    let badge = this._el("div", "pf-state-badge");

    let mute = this._el("button", "pf-tab-button pf-tab-mute");
    mute._tab = tab;
    this._setAudioState(mute, tab);

    let close = this._el("button", "pf-tab-button pf-tab-close");
    close.setAttribute("aria-label", "Close tab");
    close.title = "Close tab";

    wrap.append(thumb, badge, mute, close);
    return wrap;
  },

  // A tab is asleep when its page isn't loaded: unloaded to save memory, or
  // not restored yet after a restart. Clicking it wakes it up.
  _isSleeping(tab) {
    return tab.hasAttribute("pending") || tab.hasAttribute("discarded");
  },

  _setTabState(wrap, tab) {
    let sleeping = this._isSleeping(tab);
    let loading = !sleeping && tab.hasAttribute("busy");
    wrap.toggleAttribute("sleeping", sleeping);
    wrap.toggleAttribute("loading", loading);
    wrap.title = sleeping ? "Sleeping tab. Click to wake it up." : "";
  },

  _updateTabState(tab) {
    for (let parent of [this._dock, this._overviewGrid]) {
      for (let wrap of parent?.querySelectorAll(".pf-thumb-wrap") ?? []) {
        if (wrap._tab == tab) {
          this._setTabState(wrap, tab);
        }
      }
    }
  },

  _setAudioState(button, tab) {
    let blocked = tab.activeMediaBlocked;
    let muted = tab.muted;
    let playing = tab.soundPlaying;
    button.toggleAttribute("blocked", blocked);
    button.toggleAttribute("muted", !blocked && muted);
    // Tabs with sound going on (or muted) keep the button visible.
    button.toggleAttribute("active", blocked || muted || playing);
    let label = blocked ? "Play tab" : muted ? "Unmute tab" : "Mute tab";
    button.setAttribute("aria-label", label);
    button.title = label;
  },

  _updateAudioButtons(tab) {
    for (let parent of [this._dock, this._overviewGrid]) {
      for (let button of parent.querySelectorAll(".pf-tab-mute")) {
        if (button._tab == tab) {
          this._setAudioState(button, tab);
        }
      }
    }
  },

  // Handles a click on a thumbnail's mute or close button. Returns true if
  // the click was on one of them.
  _handleTabButton(event, tab) {
    let button = event.target.closest(".pf-tab-button");
    if (!button || !tab) {
      return false;
    }
    if (button.classList.contains("pf-tab-close")) {
      gBrowser.removeTab(tab, { animate: false });
      // TabClose re-renders the dock or full-screen view.
    } else if (tab.activeMediaBlocked) {
      tab.resumeDelayedMedia();
    } else {
      tab.toggleMuteAudio();
    }
    return true;
  },

  _iconAndTitle(tab) {
    let icon = this._el("img", "pf-dock-label-icon");
    let iconURL = gBrowser.getIcon(tab);
    if (iconURL) {
      icon.src = iconURL;
    } else {
      icon.hidden = true;
    }
    let text = this._el("span", "pf-dock-label-text");
    text.textContent = tab.label;
    return [icon, text];
  },

  // Uses the cached thumbnail when the tab hasn't navigated since, otherwise
  // the tab's icon until a fresh capture arrives.
  _fillThumb(thumb, tab) {
    let cached = this._thumbCache.get(tab);
    if (cached && cached.uri == tab.linkedBrowser?.currentURI?.spec) {
      thumb.appendChild(cached.canvas);
    } else {
      thumb.appendChild(this._createFallback(tab));
    }
  },

  _createFallback(tab) {
    let fallback = this._el("div", "pf-dock-fallback");
    let iconURL = gBrowser.getIcon(tab);
    if (iconURL) {
      let img = this._el("img");
      img.src = iconURL;
      fallback.appendChild(img);
    }
    return fallback;
  },

  _isFresh(tab) {
    let cached = this._thumbCache.get(tab);
    return !!cached && cached.uri == tab.linkedBrowser?.currentURI?.spec;
  },

  // Takes one tab's thumbnail and caches it. Returns the canvas, or null if
  // the tab can't be captured right now.
  async _captureTab(tab) {
    let browser = tab.linkedBrowser;
    if (
      !browser ||
      tab.closing ||
      tab.hasAttribute("pending") ||
      !browser.browsingContext?.currentWindowGlobal
    ) {
      return null;
    }
    let dpr = window.devicePixelRatio;
    let canvas = this._el("canvas", "pf-dock-canvas");
    canvas.width = Math.round(this.THUMB_W * dpr);
    canvas.height = Math.round(this.THUMB_H * dpr);
    let uri = browser.currentURI.spec;
    try {
      if (
        !(await this._PageThumbs.captureTabPreviewThumbnail(browser, canvas))
      ) {
        return null;
      }
    } catch (e) {
      // The tab may have closed mid-capture.
      return null;
    }
    this._thumbCache.set(tab, { canvas, uri });
    return canvas;
  },

  // Fills in thumbnails that are missing or out of date, plus the current
  // tab's (which may have scrolled or changed). Tabs whose cached thumbnail
  // still matches their page are left alone, so opening is cheap.
  async _captureThumbnails(tabs, generation, thumbFor) {
    let todo = tabs.filter(tab => tab.selected || !this._isFresh(tab));
    for (let tab of todo) {
      if (generation != this._generation) {
        return;
      }
      let canvas = await this._captureTab(tab);
      if (!canvas || generation != this._generation) {
        continue;
      }
      let thumb = thumbFor(tab);
      if (thumb) {
        thumb.textContent = "";
        thumb.appendChild(canvas);
      }
      // Give the next frame a chance to paint between captures.
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  },

  _captureAfterAnimation(tabs, thumbFor) {
    clearTimeout(this._captureTimer);
    let generation = this._generation;
    let delay = this._reduceMotion ? 0 : this.ANIMATION_MS;
    this._captureTimer = setTimeout(
      () => this._captureThumbnails(tabs, generation, thumbFor),
      delay
    );
  },

  // Keeps the current tab's thumbnail up to date while the dock is closed,
  // so it is already there the next time the dock opens.
  _scheduleBackgroundCapture() {
    clearTimeout(this._backgroundTimer);
    if (!this.enabled) {
      return;
    }
    this._backgroundTimer = setTimeout(() => {
      requestIdleCallback(
        () => {
          if (!this._isOpen && !this._overviewOpen) {
            this._captureTab(gBrowser.selectedTab);
          }
        },
        { timeout: 2000 }
      );
    }, this.BACKGROUND_CAPTURE_MS);
  },

  /* Magnification */

  // Offsets of each item's resting center from the dock's center. The mouse
  // is compared against these resting positions so the dock doesn't jitter
  // as items grow. Measured once per render, while every item is still at
  // its resting width (pins and group boxes make the spacing uneven).
  _measureCenters() {
    let rect = this._dock.getBoundingClientRect();
    let middle = rect.left + rect.width / 2;
    for (let item of this._items) {
      let r = item.getBoundingClientRect();
      item._center = r.left + r.width / 2 - middle;
    }
    this._centersStale = false;
  },

  _magnify(clientX) {
    if (this._centersStale) {
      this._measureCenters();
    }
    // Measure before changing any widths, so this is one layout per frame.
    let rect = this._dock.getBoundingClientRect();
    let mouse = clientX - (rect.left + rect.width / 2);
    for (let item of this._items) {
      let distance = Math.abs(mouse - item._center);
      let falloff = Math.max(0, 1 - distance / this.INFLUENCE_PX);
      // Ease the falloff so the growth feels rounded rather than pointy.
      let eased = Math.sin((falloff * Math.PI) / 2);
      let scale = 1 + (this.MAX_SCALE - 1) * eased;
      item.style.width = Math.round(this._baseWidth * scale) + "px";
    }
  },

  _resetMagnify() {
    cancelAnimationFrame(this._magnifyFrame);
    this._magnifyFrame = 0;
    for (let item of this._items) {
      item.style.width = this._baseWidth + "px";
    }
  },

  /* Dock actions */

  _onDockClick(event) {
    if (event.button != 0) {
      return;
    }
    // The click that ends a drag isn't a click on a tab.
    if (this._suppressClick) {
      this._suppressClick = false;
      return;
    }
    let label = event.target.closest(".pf-dock-group-label");
    if (label) {
      let group = label.parentNode._group;
      group.collapsed = !group.collapsed;
      // TabGroupCollapse/TabGroupExpand re-render the dock.
      return;
    }
    let deck = event.target.closest(".pf-dock-deck");
    if (deck) {
      deck._group.collapsed = false;
      return;
    }
    let pin = event.target.closest(".pf-dock-pin");
    if (pin?._tab) {
      gBrowser.selectedTab = pin._tab;
      this.close();
      return;
    }
    if (event.target.closest(".pf-dock-newtab")) {
      this.close();
      BrowserCommands.openTab();
      return;
    }
    if (event.target.closest(".pf-dock-showall")) {
      this.openOverview();
      return;
    }
    let item = event.target.closest(".pf-dock-item");
    if (!item?._tab || item._tab.closing) {
      return;
    }
    if (this._handleTabButton(event, item._tab)) {
      return;
    }
    gBrowser.selectedTab = item._tab;
    this.close();
  },

  _onDockAuxClick(event) {
    if (event.button != 1) {
      return;
    }
    let item = event.target.closest(".pf-dock-item, .pf-dock-pin");
    if (item?._tab) {
      event.preventDefault();
      gBrowser.removeTab(item._tab, { animate: false });
      // TabClose re-renders the dock.
    }
  },

  /* Right-click menu */

  // Opens Firefox's own tab menu (pin, add to group, move to a new window,
  // and so on) for the thumbnail, pin or card that was right-clicked.
  _onContextMenu(event) {
    let element = event.target.closest(
      ".pf-dock-item, .pf-dock-pin, .pf-overview-card"
    );
    let tab = element?._tab;
    let menu = document.getElementById("tabContextMenu");
    if (!tab || !menu || tab.closing) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // The menu finds its tab through the clicked node's `tab` property.
    event.target.tab = tab;
    // Firefox loads the menu's text the first time a tab in the tab strip is
    // right-clicked. Load it here too, or the menu opens with blank items.
    gBrowser.translateTabContextMenu();
    this._menuOpen = true;
    menu.addEventListener(
      "popuphidden",
      () => {
        this._menuOpen = false;
        // Close the dock if the mouse left it while the menu was open.
        if (this._isOpen && !this._zone.matches(":hover")) {
          this._onZoneLeave();
        }
      },
      { once: true }
    );
    menu.openPopupAtScreen(event.screenX, event.screenY, true, event);
  },

  /* The group name and colour panel */

  // Firefox points its "name this group" panel at the group's label in the
  // tab strip. Pufferfish hides the tab strip, so the panel would close as
  // soon as it opened, and Firefox treats that as cancelling and removes the
  // new group. When the label can't be seen, point the panel at the group in
  // the dock (or the full-screen view) instead.
  _hookGroupEditor() {
    let panel = gBrowser.tabGroupMenu?.panel;
    if (!panel) {
      return;
    }
    let openPopup = panel.openPopup;
    this._unhookGroupEditor = () => delete panel.openPopup;
    panel.openPopup = (anchor, options, ...rest) => {
      let group = anchor?.closest?.("tab-group");
      let rect = anchor?.getBoundingClientRect?.();
      let hidden =
        !rect ||
        rect.width == 0 ||
        rect.height == 0 ||
        !anchor.checkVisibility({ visibilityProperty: true });
      if (group && hidden && this.enabled) {
        let target = this._groupEditorAnchor(group);
        if (target) {
          anchor = target.anchor;
          options = { ...(options || {}), position: target.position };
          this._holdForEditor(panel);
        }
      }
      return openPopup.call(panel, anchor, options, ...rest);
    };
  },

  _groupEditorAnchor(group) {
    if (this._overviewOpen) {
      this._renderOverview();
      let section = [
        ...this._overviewGrid.querySelectorAll(".pf-overview-section"),
      ].find(s => s._group == group);
      let name = section?.querySelector(".pf-overview-section-name");
      return name ? { anchor: name, position: "bottomleft topleft" } : null;
    }
    // The group may have just been made, so build the dock afresh.
    this._prepared = false;
    if (this._isOpen) {
      this._render();
      this._prepared = true;
    } else {
      this.open();
    }
    let box = [...this._dock.querySelectorAll(".pf-dock-group")].find(
      g => g._group == group
    );
    let label = box?.querySelector(".pf-dock-group-label");
    if (!label) {
      return null;
    }
    let atBottom = this._container.getAttribute("position") == "bottom";
    return {
      anchor: label,
      position: atBottom ? "topleft bottomleft" : "bottomleft topleft",
    };
  },

  // Keep the dock open while the panel points at it.
  _holdForEditor(panel) {
    this._editorOpen = true;
    clearTimeout(this._closeTimer);
    panel.addEventListener(
      "popuphidden",
      () => {
        this._editorOpen = false;
        if (this._renderAfterEditor) {
          this._renderAfterEditor = false;
          this._queueRender();
        }
        if (this._isOpen && !this._zone.matches(":hover")) {
          this._onZoneLeave();
        }
      },
      { once: true }
    );
  },

  /* Dragging tabs in the dock */

  DRAG_THRESHOLD_PX: 6,
  // How far below (or above) the dock the mouse must go for a drop to open
  // the tab in a new window.
  NEW_WINDOW_DISTANCE_PX: 60,

  _onDockMouseDown(event) {
    if (event.button != 0 || event.target.closest(".pf-tab-button")) {
      return;
    }
    let source = event.target.closest(".pf-dock-item, .pf-dock-pin");
    if (!source?._tab) {
      return;
    }
    // Keep the browser from starting its own drag of the thumbnail image.
    event.preventDefault();
    this._drag = {
      tab: source._tab,
      source,
      startX: event.screenX,
      startY: event.screenY,
      started: false,
      target: null,
    };
    window.addEventListener("mousemove", this, true);
    window.addEventListener("mouseup", this, true);
    window.addEventListener("keydown", this, true);
  },

  handleEvent(event) {
    if (!this._drag) {
      return;
    }
    switch (event.type) {
      case "mousemove":
        this._onDragMove(event);
        break;
      case "mouseup":
        this._endDrag(event.button == 0);
        break;
      case "keydown":
        if (event.key == "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this._endDrag(false);
        }
        break;
    }
  },

  _onDragMove(event) {
    let drag = this._drag;
    if (!drag.started) {
      let moved = Math.hypot(
        event.screenX - drag.startX,
        event.screenY - drag.startY
      );
      if (moved < this.DRAG_THRESHOLD_PX) {
        return;
      }
      drag.started = true;
      clearTimeout(this._closeTimer);
      this._resetMagnify();
      drag.source.setAttribute("dragging", "true");
      this._dock.setAttribute("dragging", "true");
      drag.ghost = this._createGhost(drag.tab);
      this._container.appendChild(drag.ghost);
      drag.indicator = this._el("div", "pf-drop-indicator");
      drag.indicator.hidden = true;
      this._dock.appendChild(drag.indicator);
    }
    let box = this._container.getBoundingClientRect();
    drag.ghost.style.transform = `translate(${event.clientX - box.left + 12}px, ${event.clientY - box.top + 12}px)`;
    this._updateDropTarget(event.clientX, event.clientY);
  },

  _createGhost(tab) {
    let ghost = this._el("div", "pf-drag-ghost");
    let thumb = this._el("div", "pf-dock-thumb");
    let cached = this._thumbCache.get(tab);
    if (cached) {
      // A canvas can only be in one place; draw a copy for the ghost.
      let copy = this._el("canvas", "pf-dock-canvas");
      copy.width = cached.canvas.width;
      copy.height = cached.canvas.height;
      copy.getContext("2d").drawImage(cached.canvas, 0, 0);
      thumb.appendChild(copy);
    } else {
      thumb.appendChild(this._createFallback(tab));
    }
    let hint = this._el("div", "pf-drag-hint");
    hint.textContent = "Open in new window";
    ghost.append(thumb, hint);
    return ghost;
  },

  // Works out where the dragged tab would land and shows it.
  _updateDropTarget(x, y) {
    let drag = this._drag;
    let dock = this._dock;
    let dockRect = dock.getBoundingClientRect();
    let target = null;

    let inDock =
      x >= dockRect.left - 16 &&
      x <= dockRect.right + 16 &&
      y >= dockRect.top - 16 &&
      y <= dockRect.bottom + 16;
    let top = this._container.getAttribute("position") != "bottom";
    let awayFromDock = top
      ? y > dockRect.bottom + this.NEW_WINDOW_DISTANCE_PX
      : y < dockRect.top - this.NEW_WINDOW_DISTANCE_PX;

    if (inDock) {
      let hit = document.elementFromPoint(x, y);
      let pins = this._pins;
      let pinsRect = pins.getBoundingClientRect();
      let group = hit?.closest(".pf-dock-group");
      if (
        hit?.closest(".pf-dock-pins") ||
        (x <= pinsRect.right && pinsRect.width > 0)
      ) {
        let before = [...pins.children].find(pin => {
          let r = pin.getBoundingClientRect();
          return x < r.left + r.width / 2 && y < r.bottom;
        });
        target = { kind: "pin", before: before?._tab ?? null, element: before };
      } else if (group?.hasAttribute("collapsed")) {
        target = { kind: "deck", group: group._group };
      } else if (group) {
        let items = [...group.querySelectorAll(":scope > .pf-dock-item")];
        let before = items.find(item => {
          let r = item.getBoundingClientRect();
          return x < r.left + r.width / 2;
        });
        target = {
          kind: "group",
          group: group._group,
          before: before?._tab ?? null,
          element: before,
          last: items.at(-1),
        };
      } else {
        // Between top-level entries: ungrouped tabs and whole groups.
        let entries = [...dock.children].filter(el =>
          el.matches(".pf-dock-item, .pf-dock-group")
        );
        let before = entries.find(el => {
          let r = el.getBoundingClientRect();
          return x < r.left + r.width / 2;
        });
        target = {
          kind: "row",
          before: before ? (before._tab ?? before._group) : null,
          element: before,
          last: entries.at(-1),
        };
      }
    } else if (awayFromDock && !drag.tab.pinned) {
      target = { kind: "window" };
    }

    drag.target = target;
    this._showDropTarget(target);
  },

  _showDropTarget(target) {
    let drag = this._drag;
    let dock = this._dock;
    for (let el of dock.querySelectorAll("[drop-target]")) {
      el.removeAttribute("drop-target");
    }
    drag.ghost.toggleAttribute("new-window", target?.kind == "window");

    let indicator = drag.indicator;
    indicator.hidden = true;
    if (!target || target.kind == "window") {
      return;
    }
    if (target.kind == "pin") {
      this._pins.setAttribute("drop-target", "true");
      return;
    }
    if (target.kind == "deck" || target.kind == "group") {
      [...dock.querySelectorAll(".pf-dock-group")]
        .find(box => box._group == target.group)
        ?.setAttribute("drop-target", "true");
      if (target.kind == "deck") {
        return;
      }
    }
    // A line just before the entry the tab will land in front of, or just
    // after the last one.
    let anchor = target.element ?? target.last;
    if (!anchor) {
      return;
    }
    let dockRect = dock.getBoundingClientRect();
    let r = anchor.getBoundingClientRect();
    let x = target.element ? r.left - this.GAP / 2 : r.right + this.GAP / 2;
    indicator.style.left = x - dockRect.left + dock.scrollLeft - 1.5 + "px";
    indicator.style.top = r.top - dockRect.top + "px";
    indicator.style.height = r.height + "px";
    indicator.hidden = false;
  },

  _endDrag(drop) {
    let drag = this._drag;
    this._drag = null;
    window.removeEventListener("mousemove", this, true);
    window.removeEventListener("mouseup", this, true);
    window.removeEventListener("keydown", this, true);
    if (!drag?.started) {
      // A plain click; the click handler takes it from here.
      return;
    }
    this._suppressClick = true;
    // The click (if any) fires right after mouseup; forget it after that.
    setTimeout(() => (this._suppressClick = false), 0);
    drag.ghost.remove();
    drag.indicator.remove();
    drag.source.removeAttribute("dragging");
    this._dock.removeAttribute("dragging");
    for (let el of this._dock.querySelectorAll("[drop-target]")) {
      el.removeAttribute("drop-target");
    }

    if (drop && drag.target && !drag.tab.closing) {
      try {
        this._performDrop(drag.tab, drag.target);
      } catch (e) {
        console.error("Puff Dock: couldn't move the tab", e);
      }
    }
    // Catch up on anything that changed while dragging.
    this._prepared = false;
    this._queueRender();
    if (this._isOpen && !this._zone.matches(":hover")) {
      this._onZoneLeave();
    }
  },

  // Moves the tab to where it was dropped, using Firefox's own tab moving,
  // so the order, pins and groups are the real ones everywhere.
  _performDrop(tab, target) {
    switch (target.kind) {
      case "window":
        this.close();
        gBrowser.replaceTabWithWindow(tab);
        return;
      case "pin": {
        if (!tab.pinned) {
          gBrowser.pinTab(tab);
        }
        if (target.before && target.before != tab) {
          gBrowser.moveTabBefore(tab, target.before);
        } else if (!target.before) {
          let lastPinned = gBrowser.tabs[gBrowser.pinnedTabCount - 1];
          if (lastPinned && lastPinned != tab) {
            gBrowser.moveTabAfter(tab, lastPinned);
          }
        }
        return;
      }
      case "deck":
        if (tab.pinned) {
          gBrowser.unpinTab(tab);
        }
        gBrowser.moveTabToExistingGroup(tab, target.group);
        return;
      case "group": {
        if (tab.pinned) {
          gBrowser.unpinTab(tab);
        }
        // Next to a grouped tab, Firefox puts the tab in that group.
        if (target.before) {
          if (target.before != tab) {
            gBrowser.moveTabBefore(tab, target.before);
          }
        } else {
          let last = target.group.tabs.at(-1);
          if (last && last != tab) {
            gBrowser.moveTabAfter(tab, last);
          } else if (!last) {
            gBrowser.moveTabToExistingGroup(tab, target.group);
          }
        }
        return;
      }
      case "row": {
        if (tab.pinned) {
          gBrowser.unpinTab(tab);
        }
        // Next to an ungrouped tab or a whole group, the tab leaves its group.
        if (target.before) {
          if (target.before != tab) {
            gBrowser.moveTabBefore(tab, target.before);
          }
        } else {
          let last = target.last?._tab ?? target.last?._group;
          if (last && last != tab) {
            gBrowser.moveTabAfter(tab, last);
          }
        }
        if (tab.group && !target.before?.group) {
          gBrowser.ungroupTab(tab);
        }
      }
    }
  },

  /* Full-screen view */

  _buildOverview() {
    let overview = this._el("div", "pf-overview");
    overview.setAttribute("role", "dialog");
    overview.setAttribute("aria-label", "All tabs");

    let header = this._el("div", "pf-overview-header");

    let search = this._el("div", "pf-overview-search");
    let input = this._el("input", "pf-overview-input");
    input.type = "search";
    input.placeholder = "Search your tabs";
    input.setAttribute("aria-label", "Search your tabs");
    search.appendChild(input);

    let count = this._el("span", "pf-overview-count");

    let closeButton = this._el("button", "pf-overview-close");
    closeButton.setAttribute("aria-label", "Close");
    closeButton.title = "Close (Esc)";

    header.append(search, count, closeButton);

    let grid = this._el("div", "pf-overview-grid");
    grid.setAttribute("role", "listbox");
    grid.setAttribute("aria-label", "Open tabs");

    let hints = this._el("div", "pf-overview-hints");
    hints.textContent =
      "Type to filter · Arrows to move · Enter to switch · Esc to go back · Middle-click closes a tab";

    overview.append(header, grid, hints);
    this._container.appendChild(overview);

    this._overview = overview;
    this._overviewInput = input;
    this._overviewCount = count;
    this._overviewGrid = grid;

    input.addEventListener("input", () => {
      this._keyIndex = 0;
      this._renderOverview();
    });
    overview.addEventListener("keydown", e => this._onOverviewKeyDown(e));
    closeButton.addEventListener("click", () => this.closeOverview());
    grid.addEventListener("click", e => this._onCardClick(e));
    grid.addEventListener("auxclick", e => this._onCardAuxClick(e));
    grid.addEventListener("mousedown", e => {
      if (e.button == 1) {
        e.preventDefault();
      }
    });
    grid.addEventListener("contextmenu", e => this._onContextMenu(e));
    // Clicking the empty space around the cards goes back to the page.
    overview.addEventListener("click", e => {
      if (
        e.target == overview ||
        e.target == grid ||
        e.target.matches(".pf-overview-section, .pf-overview-cards")
      ) {
        this.closeOverview();
      }
    });
  },

  openOverview() {
    if (!this.enabled) {
      return false;
    }
    if (this._overviewOpen) {
      this._overviewInput.focus();
      return true;
    }
    this.close();
    this._overviewOpen = true;
    this._overviewInput.value = "";
    this._renderOverview();
    // Start the keyboard on the current tab.
    this._keyIndex = Math.max(
      0,
      this._cards.findIndex(card => card._tab == gBrowser.selectedTab)
    );
    this._markKeyCard();
    this._container.setAttribute("overview", "true");
    this._overviewInput.focus();
    this._cards[this._keyIndex]?.scrollIntoView({ block: "nearest" });
    return true;
  },

  closeOverview() {
    if (!this._overviewOpen) {
      return;
    }
    this._overviewOpen = false;
    this._generation++;
    this._container.removeAttribute("overview");
    this._overviewGrid.textContent = "";
    this._cards = [];
    gBrowser.selectedBrowser.focus();
  },

  toggleOverview() {
    if (this._overviewOpen) {
      this.closeOverview();
    } else {
      this.openOverview();
    }
  },

  _matchingTabs() {
    let query = this._overviewInput.value.trim().toLowerCase();
    let tabs = this._allTabs();
    if (!query) {
      return tabs;
    }
    let words = query.split(/\s+/);
    return tabs.filter(tab => {
      let text = (
        tab.label +
        " " +
        (tab.linkedBrowser?.currentURI?.spec ?? "")
      ).toLowerCase();
      return words.every(word => text.includes(word));
    });
  },

  _renderOverview() {
    ++this._generation;
    let searching = !!this._overviewInput.value.trim();
    let tabs = this._matchingTabs();
    let total = this._allTabs().length;
    let grid = this._overviewGrid;
    grid.textContent = "";
    this._cards = [];

    this._overviewCount.textContent = searching
      ? `${tabs.length} of ${total} tabs`
      : `${total} ${total == 1 ? "tab" : "tabs"}`;

    if (!tabs.length) {
      let empty = this._el("div", "pf-overview-empty");
      empty.textContent = "No tabs match. Press Enter to search the web.";
      grid.appendChild(empty);
      return;
    }

    // While searching, results are one flat list; otherwise pinned tabs come
    // first, then the rest in tab order with each group as its own section.
    let sections = searching ? [{ tabs }] : this._overviewSections(tabs);
    for (let section of sections) {
      grid.appendChild(this._createSection(section));
    }

    this._keyIndex = Math.min(this._keyIndex, this._cards.length - 1);
    this._markKeyCard();

    this._captureAfterAnimation(
      this._cards.map(card => card._tab),
      tab =>
        this._cards.find(c => c._tab == tab)?.querySelector(".pf-dock-thumb")
    );
  },

  _overviewSections(tabs) {
    let sections = [];
    let pinned = tabs.filter(tab => tab.pinned);
    if (pinned.length) {
      sections.push({ pinned: true, tabs: pinned });
    }
    for (let run of this._runs(tabs.filter(tab => !tab.pinned))) {
      let last = sections.at(-1);
      // Ungrouped tabs between two groups share one section.
      if (!run.group && last && !last.group && !last.pinned) {
        last.tabs.push(...run.tabs);
      } else {
        sections.push(run);
      }
    }
    return sections;
  },

  _createSection({ group, pinned, tabs }) {
    let section = this._el("div", "pf-overview-section");
    if (pinned || group) {
      let header = this._el("div", "pf-overview-section-header");
      let name = this._el("span", "pf-overview-section-name");
      let count = this._el("span", "pf-overview-section-count");
      count.textContent = `${tabs.length} ${tabs.length == 1 ? "tab" : "tabs"}`;
      if (pinned) {
        section.setAttribute("pinned", "true");
        name.textContent = "Pinned";
        header.append(name, count);
      } else {
        section.setAttribute("group", "true");
        section._group = group;
        section.toggleAttribute("collapsed", group.collapsed);
        this._setGroupColor(section, group);
        name.textContent = this._groupName(group);
        let fold = this._el("button", "pf-overview-fold");
        fold.setAttribute(
          "aria-label",
          group.collapsed ? "Show this group's tabs" : "Fold this group"
        );
        fold.setAttribute("aria-expanded", group.collapsed ? "false" : "true");
        fold.title = fold.getAttribute("aria-label");
        header.append(fold, name, count);
        header.addEventListener("click", () => {
          group.collapsed = !group.collapsed;
          // TabGroupCollapse/TabGroupExpand re-render the view.
        });
      }
      section.appendChild(header);
    }
    if (!group?.collapsed) {
      let cards = this._el("div", "pf-overview-cards");
      for (let tab of tabs) {
        let card = this._createCard(tab);
        cards.appendChild(card);
        this._cards.push(card);
      }
      section.appendChild(cards);
    }
    return section;
  },

  _createCard(tab) {
    let card = this._el("div", "pf-overview-card");
    card.setAttribute("role", "option");
    card.setAttribute("aria-label", tab.label);
    card.toggleAttribute("selected", tab.selected);
    card._tab = tab;

    let title = this._el("div", "pf-overview-title");
    title.append(...this._iconAndTitle(tab));

    let host = this._el("div", "pf-overview-host");
    host.textContent = this._displayHost(tab);

    card.append(this._createThumbWithButtons(tab), title, host);
    return card;
  },

  _displayHost(tab) {
    let uri = tab.linkedBrowser?.currentURI;
    if (!uri) {
      return "";
    }
    try {
      if (uri.host) {
        return uri.host.replace(/^www\./, "");
      }
    } catch (e) {
      // about: and other URIs without a host.
    }
    return uri.spec.split(/[?#]/)[0];
  },

  _markKeyCard() {
    this._cards.forEach((card, i) =>
      card.toggleAttribute("keyboard", i == this._keyIndex)
    );
    this._cards[this._keyIndex]?.scrollIntoView({ block: "nearest" });
  },

  // The card above or below the current one (direction -1 or 1), by where
  // the cards are on screen, since sections break the grid into pieces.
  _verticalNeighbor(direction) {
    let current = this._cards[this._keyIndex];
    if (!current) {
      return this._keyIndex;
    }
    let r = current.getBoundingClientRect();
    let cx = r.left + r.width / 2;
    let cy = r.top + r.height / 2;
    let best = this._keyIndex;
    let bestScore = Infinity;
    this._cards.forEach((card, i) => {
      let q = card.getBoundingClientRect();
      let dy = q.top + q.height / 2 - cy;
      if (Math.sign(dy) != direction || Math.abs(dy) < r.height / 2) {
        return;
      }
      // Nearest row first, then the closest card in it.
      let score = Math.abs(dy) * 10000 + Math.abs(q.left + q.width / 2 - cx);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  },

  _onOverviewKeyDown(event) {
    // Only measure the cards for the up and down keys, not while typing.
    let move = {
      ArrowRight: () => 1,
      ArrowLeft: () => -1,
      ArrowDown: () => this._verticalNeighbor(1) - this._keyIndex,
      ArrowUp: () => this._verticalNeighbor(-1) - this._keyIndex,
    }[event.key]?.();

    if (event.key == "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeOverview();
    } else if (event.key == "Enter") {
      event.preventDefault();
      let card = this._cards[this._keyIndex];
      if (card) {
        this._switchTo(card._tab);
      } else {
        this._searchWeb(this._overviewInput.value.trim());
      }
    } else if (move !== undefined && this._cards.length) {
      event.preventDefault();
      this._keyIndex = Math.min(
        this._cards.length - 1,
        Math.max(0, this._keyIndex + move)
      );
      this._markKeyCard();
    }
  },

  _onCardClick(event) {
    if (event.button != 0) {
      return;
    }
    let card = event.target.closest(".pf-overview-card");
    if (!card?._tab) {
      return;
    }
    if (this._handleTabButton(event, card._tab)) {
      // Keep typing in the search box after muting or closing.
      this._overviewInput.focus();
      return;
    }
    this._switchTo(card._tab);
  },

  _onCardAuxClick(event) {
    if (event.button != 1) {
      return;
    }
    let card = event.target.closest(".pf-overview-card");
    if (card?._tab) {
      event.preventDefault();
      this._closeCardTab(card._tab);
    }
  },

  _closeCardTab(tab) {
    gBrowser.removeTab(tab, { animate: false });
    // TabClose re-renders the view; keep typing in the search box.
    this._overviewInput.focus();
  },

  _switchTo(tab) {
    if (tab.closing) {
      return;
    }
    gBrowser.selectedTab = tab;
    this.closeOverview();
  },

  _searchWeb(text) {
    if (!text) {
      return;
    }
    this.closeOverview();
    SearchUIUtils.loadSearch({
      window,
      searchText: text,
      where: "tab",
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    }).catch(console.error);
  },

  /* Toolbar button and shortcuts */

  _createToolbarButton() {
    let widget = CustomizableUI.getWidget(this.WIDGET_ID);
    if (widget?.provider == CustomizableUI.PROVIDER_API) {
      return;
    }
    CustomizableUI.createWidget({
      id: this.WIDGET_ID,
      type: "button",
      label: "All tabs",
      tooltiptext: "Show all tabs (Ctrl+Shift+A)",
      defaultArea: CustomizableUI.AREA_NAVBAR,
      // Runs in CustomizableUI's scope, where ownerGlobal isn't available, so
      // find the button's window through its document instead.
      onCommand(event) {
        event.target.ownerDocument.defaultView.PufferfishTabDock.toggleOverview();
      },
    });
  },

  _hookShortcuts() {
    // Ctrl+Shift+A ("Search tabs") opens the full-screen view instead of the
    // address bar's tab search.
    let searchTabs = document.getElementById("Browser:SearchTabs");
    searchTabs?.addEventListener("command", event => {
      if (this.enabled) {
        event.stopPropagation();
        this.toggleOverview();
      }
    });

    // Ctrl+Shift+Tab, and Ctrl+F or Ctrl+A while the Ctrl+Tab switcher is up,
    // normally open the "List all tabs" menu. Open the full-screen view.
    if (window.ctrlTab) {
      let showAllTabs = ctrlTab.showAllTabs;
      ctrlTab.showAllTabs = function (entrypoint) {
        if (PufferfishTabDock.enabled) {
          this.close();
          PufferfishTabDock.openOverview();
          return;
        }
        showAllTabs.call(this, entrypoint);
      };
    }
  },
};

// gBrowser is ready once the window's delayed startup has finished.
Services.obs.addObserver(function pufferfishTabDockStartup(subject) {
  if (subject == window) {
    Services.obs.removeObserver(
      pufferfishTabDockStartup,
      "browser-delayed-startup-finished"
    );
    PufferfishTabDock.init();
  }
}, "browser-delayed-startup-finished");
