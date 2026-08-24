// Live updates for the server-rendered library pages. These pages have no editable
// state, so reloading on a publish is safe; the review shell only shows a toast.
(function () {
  var script = document.currentScript || document.querySelector("script[data-aw-live]");
  if (!script || typeof EventSource === "undefined") return;
  try {
    var stream = new EventSource(new URL("../api/events", script.src).href);
    var reload = function () { location.reload(); };
    stream.addEventListener("content-changed", reload);
    stream.addEventListener("state-changed", reload);
  } catch (error) { /* live updates are an enhancement, never a requirement */ }
})();
