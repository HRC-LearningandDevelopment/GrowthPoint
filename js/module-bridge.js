/*
 * L&D Learning Companion — module bridge
 *
 * Add ONE line inside the <head> of every self-paced module:
 *
 *   <script src="https://YOUR-COMPANION-ADDRESS/js/module-bridge.js"></script>
 *
 * Then, at the point where the learner finishes the module, call:
 *
 *   LearningCompanion.complete(85);   // score in percent, 0–100
 *   LearningCompanion.complete();     // no score
 *
 * Opened inside the Learning Companion, complete() records the learner's
 * completion (and score). Opened anywhere else, the module works as usual
 * and complete() does nothing.
 */
(function () {
  "use strict";

  var COMPANION_ORIGIN = new URL(document.currentScript.src, location.href).origin;
  var connected = false;

  // Say hello to the Companion; it answers only when it opened this module
  if (window.parent !== window) {
    window.addEventListener("message", function (e) {
      if (e.origin === COMPANION_ORIGIN && e.data && e.data.type === "lc:welcome") connected = true;
    });
    var tries = 0;
    var hello = setInterval(function () {
      if (connected || ++tries > 12) return clearInterval(hello);
      window.parent.postMessage({ type: "lc:hello" }, COMPANION_ORIGIN);
    }, 400);
  }

  window.LearningCompanion = {
    complete: function (score) {
      if (!connected) return false;
      var value = typeof score === "number" && isFinite(score) ? Math.round(score * 100) / 100 : null;
      window.parent.postMessage({ type: "lc:complete", score: value }, COMPANION_ORIGIN);
      return true;
    },
  };
})();
