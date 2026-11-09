/*
 * Xblox RobloxPlayerWeb.js
 *
 * This is a browser-side bootstrap/diagnostics layer for the existing player.
 * It does NOT contain or emulate Roblox's proprietary player engine.
 * The actual engine/WASM/data files must be supplied by the upstream player.
 */
(() => {
  "use strict";

  const canvas = document.getElementById("canvas");
  const boot = document.getElementById("boot");
  const wait = document.getElementById("wait");
  const bar = document.querySelector("#bar > div");
  const errorBox = document.getElementById("error");
  const status = document.getElementById("status");

  const state = {
    started: false,
    failed: false,
    engineDetected: false,
    startedAt: Date.now()
  };

  function showError(message) {
    state.failed = true;
    document.body.classList.add("failed");
    if (errorBox) errorBox.textContent = message;
    if (boot) boot.hidden = false;
    console.error("[RobloxPlayerWeb]", message);
  }

  function setStatus(message) {
    if (status) status.textContent = message;
    console.info("[RobloxPlayerWeb]", message);
  }

  function setProgress(value) {
    const n = Math.max(0, Math.min(100, Number(value) || 0));
    if (bar) bar.style.width = n + "%";
  }

  function checkBrowser() {
    if (!window.isSecureContext) {
      throw new Error(
        "The player requires HTTPS or localhost. Open Xblox using its HTTPS address."
      );
    }

    if (!window.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      throw new Error(
        "Threaded player support is unavailable. Check the Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy response headers."
      );
    }

    if (!canvas) {
      throw new Error('The player canvas "#canvas" was not found in index.html.');
    }
  }

  function detectExistingEngine() {
    // Different player builds expose different entry points. Detect only;
    // do not invent a Module configuration or overwrite an existing one.
    const candidates = [
      window.Module,
      window.moduleConfig,
      window.RobloxPlayer,
      window.RobloxPlayerWeb
    ];

    return candidates.some((item) =>
      item && (typeof item === "object" || typeof item === "function")
    );
  }

  function showCanvas() {
    if (boot) boot.hidden = true;
    canvas.style.display = "block";
    canvas.focus({ preventScroll: true });
  }

  function start() {
    try {
      checkBrowser();
      state.engineDetected = detectExistingEngine();

      if (!state.engineDetected) {
        setStatus("Browser ready; waiting for the player engine.");
        showError(
          "Browser support is ready, but no Roblox player engine was detected. " +
          "RobloxPlayerWeb.js is only the bootstrap; the actual player JavaScript, " +
          "RobloxConsole.data.js, and required WASM/data files must also load."
        );
        return;
      }

      state.started = true;
      setProgress(100);
      setStatus("Player engine detected.");
      showCanvas();

      window.dispatchEvent(new CustomEvent("xblox:player-bootstrap-ready", {
        detail: { canvas, crossOriginIsolated: window.crossOriginIsolated }
      }));
    } catch (error) {
      showError(error && error.message ? error.message : String(error));
    }
  }

  // Keep runtime errors visible in the existing boot screen.
  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      const resource = target.src || target.href;
      showError("Could not load resource:\n" + resource);
      return;
    }

    if (event.message) {
      console.error("[Player runtime error]", event.message, event.filename || "");
    }
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    console.error("[Player promise rejection]", reason);
    if (!state.started) {
      showError(
        "Player startup failed: " +
        (reason && reason.message ? reason.message : String(reason))
      );
    }
  });

  // Emscripten builds may call these callbacks if they already exist.
  // Do not replace callbacks configured by the actual engine.
  const existingModule = window.Module;
  if (existingModule && typeof existingModule === "object") {
    const previousProgress = existingModule.setStatus;
    if (typeof previousProgress === "function") {
      existingModule.setStatus = function (message) {
        try { previousProgress.apply(this, arguments); } catch (e) {
          console.warn("[RobloxPlayerWeb] Existing setStatus callback failed", e);
        }
        if (message) setStatus(String(message));
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  window.RobloxPlayerWebBootstrap = Object.freeze({
    getState: () => ({ ...state }),
    showError,
    setStatus,
    setProgress
  });
})();
