(function initLyricLensStyles(root) {
  "use strict";

  // The actual panel CSS lives in styles/panel.css — single source of
  // truth. build-plugin.ps1 inlines its current contents into the
  // /*__INLINE_PANEL_CSS_START__*/ … /*__INLINE_PANEL_CSS_END__*/
  // marker block below before zipping the .plugin, so the BetterNCM
  // runtime sees the latest CSS without us having to manually keep
  // two copies in sync. (Previously this file held a hand-edited
  // string copy that silently drifted from panel.css and ate several
  // hours of "why isn't my style change applying" debugging.)
  //
  // In dev (node test runner), the marker block stays empty and the
  // tests don't depend on PANEL_CSS being populated — they validate
  // the manifest + behaviour of other modules.
  const PANEL_CSS =
    /*__INLINE_PANEL_CSS_START__*/""/*__INLINE_PANEL_CSS_END__*/;

  const api = { PANEL_CSS };
  root.LyricLens = root.LyricLens || {};
  root.LyricLens.Styles = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
