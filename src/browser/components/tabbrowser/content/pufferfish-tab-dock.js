/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Pufferfish tab dock.
 *
 * A small handle sits just under the address bar (or at the bottom of the
 * window). Hovering it slides out a dock of tab thumbnails that floats over
 * the page. Thumbnails near the mouse grow, like the macOS Dock.
 *
 * Prefs:
 *   pufferfish.tabs.dock.enabled   (bool)   show the handle and dock
 *   pufferfish.tabs.dock.position  (string) "top" or "bottom"
 */
var PufferfishTabDock = {
  PREF_ENABLED: "pufferfish.tabs.dock.enabled",
  PREF_POSITION: "pufferfish.tabs.dock.position",

  OPEN_DELAY_MS: 120,
  CLOSE_DELAY_MS: 250,
  BASE_WIDTH: 112,
  MIN_WIDTH: 44,
  MAX_SCALE: 1.6,
  INFLUENCE_PX: 150,
  GAP: 8,
  NEW_TAB_WIDTH: 40,
  // Canvas size in CSS pixels; big enough for a fully magnified thumbnail.
  THUMB_W: 192,
  THUMB_H: 120,

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
  _generation: 0,
  _thumbCache: new WeakMap(),

  get _PageThumbs() {
    delete this._PageThumbs;
    return (this._PageThumbs = ChromeUtils.importESModule(
      "resource://gre/modules/PageThumbs.sys.mjs"
    ).PageThumbs);
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
    this._applyPrefs();

    this._onPrefChange = () => this._applyPrefs();
    Services.prefs.addObserver(this.PREF_ENABLED, this._onPrefChange);
    Services.prefs.addObserver(this.PREF_POSITION, this._onPrefChange);

    this._onTabEvent = () => this._queueRender();
    for (let type of ["TabOpen", "TabClose", "TabSelect"]) {
      gBrowser.tabContainer.addEventListener(type, this._onTabEvent);
    }

    window.addEventListener("unload", () => this.uninit(), { once: true });
  },

  uninit() {
    Services.prefs.removeObserver(this.PREF_ENABLED, this._onPrefChange);
    Services.prefs.removeObserver(this.PREF_POSITION, this._onPrefChange);
    clearTimeout(this._openTimer);
    clearTimeout(this._closeTimer);
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
    dock.addEventListener("mousemove", e => this._magnify(e.clientX));
    dock.addEventListener("mouseleave", () => this._resetMagnify());
    dock.addEventListener("click", e => this._onDockClick(e));
    dock.addEventListener("auxclick", e => this._onDockAuxClick(e));
    // Keep a middle-click from starting autoscroll.
    dock.addEventListener("mousedown", e => {
      if (e.button == 1) {
        e.preventDefault();
      }
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
      if (e.key == "Escape" && this._isOpen) {
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
    if (!enabled) {
      this.close();
    }
  },

  /* Opening and closing */

  _onZoneEnter() {
    clearTimeout(this._closeTimer);
    if (!this._isOpen) {
      clearTimeout(this._openTimer);
      this._openTimer = setTimeout(() => this.open(), this.OPEN_DELAY_MS);
    }
  },

  _onZoneLeave() {
    clearTimeout(this._openTimer);
    if (this._isOpen) {
      clearTimeout(this._closeTimer);
      this._closeTimer = setTimeout(() => this.close(), this.CLOSE_DELAY_MS);
    }
  },

  open() {
    if (this._isOpen || this._container.hidden) {
      return;
    }
    this._isOpen = true;
    this._render();
    this._container.setAttribute("open", "true");
    window.addEventListener("keydown", this._onKeyDown, true);
  },

  close() {
    clearTimeout(this._openTimer);
    clearTimeout(this._closeTimer);
    if (!this._isOpen) {
      return;
    }
    this._isOpen = false;
    this._generation++;
    this._container.removeAttribute("open");
    this._resetMagnify();
    window.removeEventListener("keydown", this._onKeyDown, true);
  },

  /* Rendering */

  _queueRender() {
    if (!this._isOpen || this._renderQueued) {
      return;
    }
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      if (this._isOpen) {
        this._render();
      }
    });
  },

  _render() {
    let generation = ++this._generation;
    let tabs = gBrowser.visibleTabs;
    let dock = this._dock;
    dock.textContent = "";
    this._items = [];

    let available =
      this._container.clientWidth -
      64 -
      this.NEW_TAB_WIDTH -
      this.GAP * (tabs.length + 2);
    let base = Math.max(
      this.MIN_WIDTH,
      Math.min(this.BASE_WIDTH, Math.floor(available / tabs.length))
    );
    this._baseWidth = base;

    for (let tab of tabs) {
      let item = this._createItem(tab, base);
      dock.appendChild(item);
      this._items.push(item);
    }

    let newTab = this._el("div", "pf-dock-newtab");
    newTab.setAttribute("role", "button");
    newTab.setAttribute("aria-label", "New tab");
    newTab.textContent = "+";
    dock.appendChild(newTab);

    this._layoutCenters();
    this._captureThumbnails(tabs, generation);
  },

  _createItem(tab, width) {
    let item = this._el("div", "pf-dock-item");
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", tab.selected ? "true" : "false");
    item.setAttribute("aria-label", tab.label);
    item.toggleAttribute("selected", tab.selected);
    item.style.width = width + "px";
    item._tab = tab;

    let thumb = this._el("div", "pf-dock-thumb");
    let cached = this._thumbCache.get(tab);
    if (cached && cached.uri == tab.linkedBrowser?.currentURI?.spec) {
      thumb.appendChild(cached.canvas);
    } else {
      thumb.appendChild(this._createFallback(tab));
    }

    let label = this._el("div", "pf-dock-label");
    let icon = this._el("img", "pf-dock-label-icon");
    let iconURL = gBrowser.getIcon(tab);
    if (iconURL) {
      icon.src = iconURL;
    } else {
      icon.hidden = true;
    }
    let text = this._el("span", "pf-dock-label-text");
    text.textContent = tab.label;
    label.append(icon, text);

    item.append(thumb, label);
    return item;
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

  async _captureThumbnails(tabs, generation) {
    let dpr = window.devicePixelRatio;
    for (let tab of tabs) {
      if (generation != this._generation) {
        return;
      }
      let browser = tab.linkedBrowser;
      if (
        !browser ||
        tab.hasAttribute("pending") ||
        !browser.browsingContext?.currentWindowGlobal
      ) {
        continue;
      }
      let canvas = this._el("canvas", "pf-dock-canvas");
      canvas.width = Math.round(this.THUMB_W * dpr);
      canvas.height = Math.round(this.THUMB_H * dpr);
      let captured = false;
      try {
        captured = await this._PageThumbs.captureTabPreviewThumbnail(
          browser,
          canvas
        );
      } catch (e) {
        // The tab may have closed mid-capture; keep its fallback tile.
      }
      if (!captured || generation != this._generation) {
        continue;
      }
      this._thumbCache.set(tab, { canvas, uri: browser.currentURI.spec });
      let item = this._items.find(i => i._tab == tab);
      if (item) {
        let thumb = item.querySelector(".pf-dock-thumb");
        thumb.textContent = "";
        thumb.appendChild(canvas);
      }
    }
  },

  /* Magnification */

  // Offsets of each item's resting center from the dock's center. The mouse
  // is compared against these resting positions so the dock doesn't jitter
  // as items grow.
  _layoutCenters() {
    let count = this._items.length;
    let total =
      count * this._baseWidth +
      this.NEW_TAB_WIDTH +
      this.GAP * Math.max(0, count);
    let x = -total / 2;
    for (let item of this._items) {
      item._center = x + this._baseWidth / 2;
      x += this._baseWidth + this.GAP;
    }
  },

  _magnify(clientX) {
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
    for (let item of this._items) {
      item.style.width = this._baseWidth + "px";
    }
  },

  /* Actions */

  _onDockClick(event) {
    if (event.button != 0) {
      return;
    }
    if (event.target.closest(".pf-dock-newtab")) {
      this.close();
      BrowserCommands.openTab();
      return;
    }
    let item = event.target.closest(".pf-dock-item");
    if (item?._tab && !item._tab.closing) {
      gBrowser.selectedTab = item._tab;
      this.close();
    }
  },

  _onDockAuxClick(event) {
    if (event.button != 1) {
      return;
    }
    let item = event.target.closest(".pf-dock-item");
    if (item?._tab) {
      event.preventDefault();
      gBrowser.removeTab(item._tab, { animate: false });
      // TabClose re-renders the dock.
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
