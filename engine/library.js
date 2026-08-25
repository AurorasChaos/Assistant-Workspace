// Controls for the three-band library page. Every band is already rendered by the
// server with the default rule applied, so this only re-filters what is in the
// DOM: with scripting off the page is complete, just not adjustable.
(function () {
  var band = document.querySelector('[data-band="attention"]');
  var store = (function () {
    try { return window.sessionStorage; } catch (error) { return null; }
  })();

  function readFlag(key) {
    try { return store && store.getItem(key) === "1"; } catch (error) { return false; }
  }
  function writeFlag(key, value) {
    try { if (store) store.setItem(key, value ? "1" : "0"); } catch (error) { /* private mode */ }
  }

  if (band) {
    var toggle = band.querySelector("[data-awaiting-toggle]");
    var note = band.querySelector("[data-attention-note]");
    var rows = [].slice.call(band.querySelectorAll("[data-attention]"));

    var applyAttention = function () {
      var includeAwaiting = toggle ? toggle.checked : false;
      var shown = 0;
      rows.forEach(function (row) {
        var hide = !includeAwaiting && row.dataset.awaitingOnly === "1";
        row.hidden = hide;
        if (!hide) shown += 1;
      });
      if (note) {
        note.textContent = shown
          ? shown + " workspace" + (shown === 1 ? "" : "s") + " waiting. Anything completed more than 24 hours ago has left the band and is still in Projects below."
          : "Nothing is waiting on you.";
      }
    };

    if (toggle) {
      toggle.checked = readFlag("aw:attention:awaiting");
      toggle.addEventListener("change", function () {
        writeFlag("aw:attention:awaiting", toggle.checked);
        applyAttention();
      });
    }
    applyAttention();
  }

  var filters = [].slice.call(document.querySelectorAll("[data-roadmap-filter]"));
  if (filters.length) {
    var roadmaps = [].slice.call(document.querySelectorAll("[data-roadmap]"));
    var applyFilter = function (value) {
      filters.forEach(function (button) {
        button.setAttribute("aria-pressed", String(button.dataset.roadmapFilter === value));
      });
      roadmaps.forEach(function (row) {
        row.hidden = value !== "all" && row.dataset.state !== value;
      });
      try { if (store) store.setItem("aw:roadmaps:filter", value); } catch (error) { /* private mode */ }
    };
    filters.forEach(function (button) {
      button.addEventListener("click", function () { applyFilter(button.dataset.roadmapFilter); });
    });
    var saved = null;
    try { saved = store && store.getItem("aw:roadmaps:filter"); } catch (error) { saved = null; }
    if (saved && filters.some(function (b) { return b.dataset.roadmapFilter === saved; })) applyFilter(saved);
  }
})();
