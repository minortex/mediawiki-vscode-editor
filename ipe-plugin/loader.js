/* Stable entry: fetch the current plugin version (cache-busted) and load it. */
(function () {
  'use strict';
  if (window.__vcpeLoaderRan) return;
  window.__vcpeLoaderRan = true;
  var base = 'https://minortex.github.io/mediawiki-vscode-editor/ipe-plugin/';
  fetch(base + 'version.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (v) {
      var script = document.createElement('script');
      script.src = base + 'mediawiki-vscode-ipe.js?v=' + encodeURIComponent(v.version);
      document.head.append(script);
    })
    .catch(function () {});
})();
