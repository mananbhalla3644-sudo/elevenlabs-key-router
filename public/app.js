(() => {
  "use strict";

  const TOKEN_STORAGE_KEY = "eleven-keyflow:access-token";
  const POLL_INTERVAL_MS = 4000;
  const HEALTH_INTERVAL_MS = 30000;
  const MAX_EVENTS = 60;
  const MAX_VOICE_FILE_BYTES = 50 * 1024 * 1024;
  const SUPPORTED_AUDIO_EXTENSIONS = Object.freeze([
    ".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm",
  ]);
  const MODEL_LIMITS = Object.freeze({
    "eleven_flash_v2_5": 40000,
    "eleven_multilingual_v2": 10000,
    "eleven_v3": 5000,
  });

  const state = {
    maxKeys: 10,
    authRequired: false,
    token: readSessionToken(),
    keys: [],
    stats: {},
    events: [],
    snapshots: new Map(),
    hasSnapshot: false,
    audioUrl: null,
    voiceChangerFile: null,
    voiceChangerUrl: null,
    ttsController: null,
    voiceChangerController: null,
    healthTimer: null,
    keysTimer: null,
    authPromise: null,
    authResolver: null,
    authMode: false,
    authAttemptId: 0,
    authInFlight: false,
    keysRequest: null,
    connection: "checking",
    countdownTimer: null,
  };

  const dom = {};
  const byId = (id) => document.getElementById(id);

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheDom();
    bindEvents();
    renderKeys();
    renderStats();
    renderEvents();
    updateParsedCount();
    updateTtsLimit();
    addEvent("KeyFlow is ready", "Monitoring the local router and key pool.", "success");
    initializeRouter();
  }

  function cacheDom() {
    const ids = [
      "connectionPill",
      "connectionText",
      "heroAvailableCount",
      "heroCapacity",
      "statReady",
      "statReadyDetail",
      "statReadyTrend",
      "statRequests",
      "statRequestsDetail",
      "statRequestsTrend",
      "statSuccess",
      "statSuccessDetail",
      "statSuccessTrend",
      "statCooldown",
      "statCooldownDetail",
      "statCooldownTrend",
      "poolCount",
      "resetKeysButton",
      "keyForm",
      "keyInput",
      "parsedKeyCount",
      "keyFeedback",
      "capacityBar",
      "capacityTrack",
      "capacityText",
      "clearKeysButton",
      "addKeysButton",
      "keyGrid",
      "syncDot",
      "lastSync",
      "refreshKeysButton",
      "eventTotal",
      "eventList",
      "clearLogButton",
      "ttsForm",
      "ttsText",
      "ttsCharacterCount",
      "ttsTextHelp",
      "voiceId",
      "modelId",
      "outputFormat",
      "ttsFeedback",
      "generateButton",
      "generateButtonText",
      "studioStatusText",
      "downloadProgress",
      "downloadProgressLabel",
      "downloadProgressValue",
      "audioProgress",
      "audioResult",
      "audioResultMeta",
      "audioPlayer",
      "downloadAudio",
      "voiceChangerStudioStatus",
      "voiceChangerStatusText",
      "voiceChangerForm",
      "sourceAudio",
      "voiceUploadDropzone",
      "sourceAudioSize",
      "sourceAudioName",
      "sourceAudioHelp",
      "voiceChangerVoiceId",
      "voiceChangerModelId",
      "voiceChangerOutputFormat",
      "removeBackgroundNoise",
      "voiceChangerFeedback",
      "convertVoiceButton",
      "convertVoiceButtonText",
      "voiceChangerProgress",
      "voiceChangerProgressLabel",
      "voiceChangerProgressValue",
      "voiceChangerAudioProgress",
      "voiceChangerResult",
      "voiceChangerResultMeta",
      "voiceChangerPlayer",
      "downloadConvertedAudio",
      "authDialog",
      "authForm",
      "authToken",
      "authError",
      "authCancelButton",
      "unlockButton",
      "clearDialog",
      "clearForm",
      "clearCancelButton",
      "confirmClearButton",
      "toastRegion",
    ];

    ids.forEach((id) => {
      dom[id] = byId(id);
    });

    dom.syncStatus = dom.syncDot?.parentElement;
    dom.studioStatus = dom.studioStatusText?.parentElement;
  }

  function bindEvents() {
    dom.keyForm.addEventListener("submit", addKeys);
    dom.keyInput.addEventListener("input", updateParsedCount);
    dom.keyInput.addEventListener("paste", () => {
      window.setTimeout(updateParsedCount, 0);
    });
    dom.clearKeysButton.addEventListener("click", openClearDialog);
    dom.clearForm.addEventListener("submit", clearKeys);
    dom.clearCancelButton.addEventListener("click", closeClearDialog);
    dom.resetKeysButton.addEventListener("click", resetKeys);
    dom.refreshKeysButton.addEventListener("click", async () => {
      try {
        await loadKeys({ announce: true });
      } catch (error) {
        if (!state.authMode) {
          setSyncState("error", "Router unavailable");
          showToast(error.message || "Could not refresh key status.", "error");
        }
      }
    });
    dom.clearLogButton.addEventListener("click", clearEvents);

    dom.authForm.addEventListener("submit", submitToken);
    dom.authCancelButton.addEventListener("click", () => finishAuthentication(false));
    dom.authDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finishAuthentication(false);
    });

    dom.ttsText.addEventListener("input", updateTtsCount);
    dom.voiceId.addEventListener("input", renderActionAvailability);
    dom.ttsForm.addEventListener("submit", generateSpeech);
    dom.modelId.addEventListener("change", updateTtsLimit);
    dom.outputFormat.addEventListener("change", updateAudioExtension);

    dom.voiceChangerForm.addEventListener("submit", convertVoice);
    dom.sourceAudio.addEventListener("change", handleSourceAudioChange);
    dom.voiceChangerVoiceId.addEventListener("input", renderActionAvailability);
    dom.voiceChangerOutputFormat.addEventListener("change", updateVoiceAudioExtension);
    ["dragenter", "dragover"].forEach((eventName) => {
      dom.voiceUploadDropzone.addEventListener(eventName, handleAudioDragOver);
    });
    ["dragleave", "drop"].forEach((eventName) => {
      dom.voiceUploadDropzone.addEventListener(eventName, handleAudioDragLeave);
    });
    dom.voiceUploadDropzone.addEventListener("drop", handleAudioDrop);

    window.addEventListener("beforeunload", () => {
      revokeAudioUrl();
      revokeVoiceChangerUrl();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !state.authMode) {
        Promise.allSettled([loadHealth({ silent: true }), loadKeys({ silent: true })]);
      }
    });
  }

  async function initializeRouter() {
    try {
      const health = await loadHealth({ initial: true });
      if (health?.authRequired && !state.token) {
        const authorized = await requestAuthentication();
        if (!authorized) {
          setSyncState("error", "Authorization needed");
          return;
        }
      }
      await loadKeys({ initial: true });
      startPolling();
    } catch (error) {
      if (error?.name !== "AbortError" && !state.authMode) {
        setSyncState("error", "Router unavailable");
        showToast(error.message || "Could not reach the local router.", "error");
      }
    }
  }

  function startPolling() {
    window.clearInterval(state.keysTimer);
    window.clearInterval(state.healthTimer);
    window.clearInterval(state.countdownTimer);

    state.keysTimer = window.setInterval(() => {
      if (!document.hidden && !state.authMode && !dom.authDialog.open) {
        loadKeys({ silent: true }).catch((error) => {
          if (!state.authMode) setSyncState("error", "Router unavailable");
        });
      }
    }, POLL_INTERVAL_MS);

    state.healthTimer = window.setInterval(() => {
      if (!document.hidden && !state.authMode && !dom.authDialog.open) {
        loadHealth({ silent: true }).catch(() => undefined);
      }
    }, HEALTH_INTERVAL_MS);

    state.countdownTimer = window.setInterval(updateCooldownCountdowns, 1000);
  }

  function isLoopbackBrowserHost(hostname) {
    const normalized = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
    return normalized === "localhost" || normalized === "::1" || /^127\./.test(normalized);
  }

  function isCredentialTransportSecure() {
    return window.isSecureContext || window.location.protocol === "https:" || isLoopbackBrowserHost(window.location.hostname);
  }

  function readSessionToken() {
    if (!isCredentialTransportSecure()) return "";
    try {
      return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  function writeSessionToken(token) {
    if (!isCredentialTransportSecure()) return;
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // The router still works for this page load if sessionStorage is unavailable.
    }
  }

  function clearSessionToken() {
    state.token = "";
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // The in-memory token is still cleared when sessionStorage is unavailable.
    }
  }

  /* API */
  async function loadHealth({ initial = false, silent = false } = {}) {
    setSyncState("checking", silent ? "Router active" : "Checking router");
    const response = await authenticatedFetch("/api/health", { method: "GET" });
    const data = await parseJson(response);

    if (!response.ok) {
      throw new Error(getApiMessage(data, "Health check failed."));
    }

    if (Number.isInteger(data.maxKeys) && data.maxKeys > 0 && data.maxKeys <= 10) {
      state.maxKeys = data.maxKeys;
    }
    state.authRequired = data.authRequired === true;
    if (!state.authRequired) clearSessionToken();

    if (data.ok === true) {
      setSyncState("online", "Router online");
      if (initial) {
        addEvent("Local router connected", `Monitoring up to ${state.maxKeys} key slots.`, "success");
      }
    } else {
      setSyncState("offline", "Router unavailable");
    }

    updateCapacityLabels();
    return data;
  }

  function loadKeys({ initial = false, silent = false, announce = false, fresh = false } = {}) {
    if (state.keysRequest) {
      if (!fresh) return state.keysRequest;
      return state.keysRequest
        .catch(() => undefined)
        .then(() => loadKeys({ initial, silent, announce }));
    }

    const request = performKeyLoad({ initial, silent, announce });
    state.keysRequest = request;
    return request.finally(() => {
      if (state.keysRequest === request) state.keysRequest = null;
    });
  }

  async function performKeyLoad({ initial, silent, announce }) {
    if (!silent) setSyncState("syncing", "Syncing keys");
    dom.keyGrid?.setAttribute("aria-busy", "true");

    try {
      const response = await authenticatedFetch("/api/keys", { method: "GET" });
      const data = await parseJson(response);
      if (!response.ok) {
        throw new Error(getApiMessage(data, "Could not load key status."));
      }

      const snapshot = normalizeKeySnapshot(data);
      const previousSignature = keySnapshotSignature(state.keys);
      detectKeyChanges();
      const changed = !state.hasSnapshot || previousSignature !== keySnapshotSignature(snapshot.keys);

      state.keys = snapshot.keys;
      state.stats = snapshot.stats;
      state.maxKeys = snapshot.maxKeys;
      state.snapshots = makeSnapshots(state.keys);
      state.hasSnapshot = true;

      if (changed) renderKeys();
      updateCapacityLabels();
      setSyncState("online", "Router online");
      updateSyncTime();

      if (announce) addEvent("Key status refreshed", `${state.keys.length} key${plural(state.keys.length)} synchronized.`, "info");
      if (initial) addEvent("Key pool synchronized", state.keys.length ? `${state.keys.length} key${plural(state.keys.length)} ready for routing.` : "Add a key to activate the router.", "info");
      return snapshot;
    } finally {
      dom.keyGrid?.setAttribute("aria-busy", "false");
    }
  }

  async function refreshKeySnapshotAfterMutation() {
    try {
      await loadKeys({ silent: true, fresh: true });
      return true;
    } catch {
      setSyncState("error", "Status refresh failed");
      showToast("The change was saved, but the key status could not be refreshed.", "error");
      return false;
    }
  }

  async function addKeys(event) {
    event.preventDefault();
    if (!isCredentialTransportSecure()) {
      setKeyFeedback("Use HTTPS before sending ElevenLabs keys to this dashboard.", "error");
      return;
    }
    const keys = parseKeyInput(dom.keyInput.value);
    const remaining = Math.max(0, state.maxKeys - state.keys.length);

    if (!keys.length) {
      setKeyFeedback("Paste at least one API key.", "error");
      dom.keyInput.focus();
      return;
    }

    if (!remaining) {
      setKeyFeedback(`The pool is full at ${state.maxKeys} keys. Clear a key before adding more.`, "error");
      return;
    }

    if (keys.length > remaining) {
      setKeyFeedback(`Only ${remaining} slot${plural(remaining)} available. The extra keys were not sent.`, "error");
      return;
    }

    setButtonBusy(dom.addKeysButton, true, "Adding…");
    setKeyFeedback("Sending keys to the local server…", "");

    try {
      const result = await apiJson("/api/keys", {
        method: "POST",
        body: JSON.stringify({ keys }),
      });
      const added = Number.isInteger(result?.added) ? result.added : keys.length;
      dom.keyInput.value = "";
      updateParsedCount();
      setKeyFeedback(
        added ? `${added} key${plural(added)} added securely.` : "Those keys are already in the pool.",
        "success",
      );
      addEvent(
        added ? "Key pool updated" : "Duplicate keys skipped",
        added ? `${added} key${plural(added)} sent to the local server.` : "The local router already had every pasted key.",
        added ? "success" : "info",
      );
      showToast(added ? `${added} key${plural(added)} added.` : "No new keys to add.", added ? "success" : "info");
      await refreshKeySnapshotAfterMutation();
    } catch (error) {
      setKeyFeedback(error.message || "Could not add keys.", "error");
      showToast(error.message || "Could not add keys.", "error");
    } finally {
      setButtonBusy(dom.addKeysButton, false);
    }
  }

  async function clearKeys(event) {
    event.preventDefault();
    closeClearDialog();
    setButtonBusy(dom.confirmClearButton, true, "Clearing…");
    setButtonBusy(dom.clearKeysButton, true, "Clearing…");

    try {
      await apiJson("/api/keys", { method: "DELETE" });
      addEvent("Key pool cleared", "All keys currently held in server memory were removed.", "warning");
      showToast("Key pool cleared.", "success");
      await refreshKeySnapshotAfterMutation();
    } catch (error) {
      showToast(error.message || "Could not clear the key pool.", "error");
    } finally {
      setButtonBusy(dom.confirmClearButton, false);
      setButtonBusy(dom.clearKeysButton, false);
      renderActionAvailability();
    }
  }

  async function resetKeys() {
    setButtonBusy(dom.resetKeysButton, true, "Resetting…");

    try {
      await apiJson("/api/keys/reset", { method: "POST" });
      addEvent("Cooldowns reset", "Temporary cooldowns were cleared; disabled keys remain disabled.", "success");
      showToast("Key cooldowns reset.", "success");
      await refreshKeySnapshotAfterMutation();
    } catch (error) {
      showToast(error.message || "Could not reset key state.", "error");
    } finally {
      setButtonBusy(dom.resetKeysButton, false);
      renderActionAvailability();
    }
  }

  function requestAuthentication() {
    if (dom.authDialog.open && state.authPromise) return state.authPromise;

    state.authMode = true;
    state.authAttemptId += 1;
    clearSessionToken();
    const secureTransport = isCredentialTransportSecure();
    dom.authToken.value = "";
    dom.authToken.disabled = !secureTransport;
    dom.unlockButton.disabled = !secureTransport;
    dom.authError.textContent = secureTransport
      ? ""
      : "This deployment must use HTTPS before a dashboard token or ElevenLabs key can be entered.";
    dom.authDialog.showModal();
    window.setTimeout(() => {
      if (!dom.authDialog.open) return;
      (secureTransport ? dom.authToken : dom.authCancelButton).focus();
    }, 50);

    state.authPromise = new Promise((resolve) => {
      state.authResolver = resolve;
    });
    return state.authPromise;
  }

  async function submitToken(event) {
    event.preventDefault();
    if (state.authInFlight) return;
    if (!isCredentialTransportSecure()) {
      dom.authError.textContent = "Open this dashboard over HTTPS before entering a token.";
      return;
    }

    const token = dom.authToken.value.trim();
    if (!token) {
      dom.authError.textContent = "Enter the access token configured on your server.";
      dom.authToken.focus();
      return;
    }

    const attemptId = state.authAttemptId;
    state.authInFlight = true;
    state.token = token;
    setButtonBusy(dom.unlockButton, true, "Unlocking…");
    dom.authError.textContent = "";

    try {
      const response = await fetch("/api/keys", createFetchOptions({ method: "GET" }));
      const data = await parseJson(response);
      if (!response.ok) {
        clearSessionToken();
        dom.authError.textContent = response.status === 401
          ? "That token was not accepted. Check the server configuration and try again."
          : getApiMessage(data, "The router could not verify that token.");
        return;
      }

      if (attemptId !== state.authAttemptId || !dom.authDialog.open) return;
      writeSessionToken(token);
      finishAuthentication(true);
    } catch {
      clearSessionToken();
      if (attemptId === state.authAttemptId && dom.authDialog.open) {
        dom.authError.textContent = "Could not verify the token. Check that the router is reachable and try again.";
      }
    } finally {
      state.authInFlight = false;
      if (dom.unlockButton) setButtonBusy(dom.unlockButton, false);
    }
  }

  function finishAuthentication(success) {
    state.authAttemptId += 1;
    const resolver = state.authResolver;
    state.authResolver = null;
    state.authPromise = null;
    if (dom.authDialog.open) dom.authDialog.close();
    state.authMode = false;
    if (!success) clearSessionToken();
    if (resolver) resolver(Boolean(success));
  }

  async function authenticatedFetch(path, options = {}) {
    let response = await fetch(path, createFetchOptions(options));
    let attempts = 0;

    while (isRouterAuthChallenge(response) && attempts < 2) {
      const authorized = await requestAuthentication();
      if (!authorized) {
        throw new Error("Authorization is required to use this router.");
      }
      response = await fetch(path, createFetchOptions(options));
      attempts += 1;
    }

    if (isRouterAuthChallenge(response)) {
      throw new Error("The access token was not accepted.");
    }
    return response;
  }

  function isRouterAuthChallenge(response) {
    const authenticate = response.headers.get("www-authenticate") || "";
    return response.status === 401 && authenticate.toLowerCase().includes("bearer");
  }

  function createFetchOptions(options) {
    const headers = new Headers(options.headers || {});
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (state.token) headers.set("Authorization", `Bearer ${state.token}`);

    return {
      cache: "no-store",
      ...options,
      headers,
    };
  }

  async function apiJson(path, options) {
    const response = await authenticatedFetch(path, options);
    const data = await parseJson(response);
    if (!response.ok) throw new Error(getApiMessage(data, `Request failed (${response.status}).`));
    return data;
  }

  async function parseJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  function getApiMessage(data, fallback) {
    if (typeof data === "string" && data) return data;
    if (!data || typeof data !== "object") return fallback;
    if (typeof data.error === "string" && data.error) return data.error;
    if (data.error && typeof data.error === "object") {
      return data.error.message || data.error.code || fallback;
    }
    return data.message || data.detail || fallback;
  }

  /* Keys and stats */
  function renderKeys() {
    dom.keyGrid.replaceChildren();

    if (!state.keys.length) {
      const empty = document.createElement("div");
      empty.className = "key-empty-state";
      empty.innerHTML = `
        <span class="empty-illustration" aria-hidden="true">
          <svg viewBox="0 0 64 64"><rect x="13" y="25" width="38" height="27" rx="7"></rect><path d="M21 25v-6a11 11 0 0 1 22 0v6M32 36v7"></path><circle cx="32" cy="33" r="2"></circle></svg>
        </span>
        <h3>Your key pool is empty</h3>
        <p>Add a key above to start routing requests automatically.</p>
      `;
      dom.keyGrid.append(empty);
    } else {
      const fragment = document.createDocumentFragment();
      state.keys.forEach((key, index) => fragment.append(createKeyCard(key, index)));
      dom.keyGrid.append(fragment);
    }

    renderActionAvailability();
    updateParsedCount();
  }

  function createKeyCard(key, index) {
    const requests = toCount(key.requestCount);
    const successes = Math.min(requests, toCount(key.successCount));
    const successRate = requests ? Math.round((successes / requests) * 100) : 0;
    const visualStatus = getVisualStatus(key);
    const cooldownRemaining = getCooldownRemaining(key.cooldownUntil);
    const card = document.createElement("article");
    card.className = `key-card status-${visualStatus.kind}`;
    card.setAttribute("aria-label", `Key ${key.label || key.id || index + 1}, ${visualStatus.label}`);

    const head = document.createElement("div");
    head.className = "key-card-head";

    const identity = document.createElement("div");
    identity.className = "key-card-identity";

    const keyIndex = document.createElement("span");
    keyIndex.className = "key-index";
    keyIndex.textContent = String(index + 1).padStart(2, "0");

    const name = document.createElement("span");
    name.className = "key-card-name";
    const label = document.createElement("strong");
    label.textContent = key.label || `API key ${index + 1}`;
    const masked = document.createElement("code");
    masked.textContent = key.maskedKey || "••••••••••••••••";
    name.append(label, masked);

    const status = document.createElement("span");
    status.className = `status-label status-${visualStatus.kind}`;
    const statusDot = document.createElement("i");
    statusDot.setAttribute("aria-hidden", "true");
    const statusText = document.createElement("span");
    statusText.dataset.role = "status-text";
    statusText.textContent = visualStatus.shortLabel;
    status.append(statusDot, statusText);

    identity.append(keyIndex, name);
    head.append(identity, status);

    const metrics = document.createElement("div");
    metrics.className = "key-metrics";
    metrics.append(
      createMetric("Requests", formatCompact(requests)),
      createMetric("Successful", formatCompact(successes)),
      createMetric("Success", `${successRate}%`),
    );

    const progressWrap = document.createElement("div");
    progressWrap.className = "key-progress";
    progressWrap.setAttribute("role", "progressbar");
    progressWrap.setAttribute("aria-label", `${key.label || "Key"} success rate`);
    progressWrap.setAttribute("aria-valuemin", "0");
    progressWrap.setAttribute("aria-valuemax", "100");
    progressWrap.setAttribute("aria-valuenow", String(successRate));
    const progress = document.createElement("span");
    progress.style.width = `${successRate}%`;
    progressWrap.append(progress);

    const foot = document.createElement("div");
    foot.className = "key-card-foot";
    const lastUsed = document.createElement("span");
    lastUsed.dataset.role = "last-used";
    lastUsed.textContent = key.lastUsedAt ? `Last used ${formatRelativeTime(key.lastUsedAt)}` : "Never used";
    const cooldown = document.createElement("span");
    cooldown.dataset.role = "cooldown";
    if (cooldownRemaining > 0) {
      cooldown.textContent = `${formatDuration(cooldownRemaining)} remaining`;
    } else {
      cooldown.textContent = "No active cooldown";
    }
    foot.append(lastUsed, cooldown);

    card.append(head, metrics, progressWrap, foot);

    if (key.lastError) {
      const error = document.createElement("p");
      error.className = "key-error";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", "12");
      circle.setAttribute("cy", "12");
      circle.setAttribute("r", "9");
      const lineOne = document.createElementNS("http://www.w3.org/2000/svg", "path");
      lineOne.setAttribute("d", "M12 7v6m0 4h.01");
      icon.append(circle, lineOne);
      const errorText = document.createElement("span");
      errorText.textContent = truncate(String(key.lastError), 130);
      error.append(icon, errorText);
      card.append(error);
    }

    return card;
  }

  function createMetric(label, value) {
    const wrapper = document.createElement("span");
    wrapper.className = "key-metric";
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = document.createElement("strong");
    valueNode.textContent = value;
    wrapper.append(labelNode, valueNode);
    return wrapper;
  }

  function renderStats() {
    const total = state.keys.length;
    const requests = state.keys.reduce((sum, key) => sum + toCount(key.requestCount), 0);
    const successes = state.keys.reduce((sum, key) => sum + toCount(key.successCount), 0);
    const ready = state.keys.filter((key) => getVisualStatus(key).kind === "ready").length;
    const cooling = state.keys.filter((key) => {
      const status = getVisualStatus(key);
      return status.kind === "cooldown" || getCooldownRemaining(key.cooldownUntil) > 0;
    }).length;
    const successRate = requests ? Math.round((Math.min(successes, requests) / requests) * 100) : 0;

    dom.statReady.textContent = String(ready);
    dom.statReadyDetail.textContent = `of ${total} in pool`;
    dom.statReadyTrend.textContent = total ? (ready ? "Available" : "None") : "Local";

    dom.statRequests.textContent = formatCompact(requests);
    dom.statRequestsDetail.textContent = `${formatCompact(successes)} successful call${plural(successes)}`;
    dom.statRequestsTrend.textContent = requests ? "Tracked" : "Live";

    dom.statSuccess.textContent = `${successRate}%`;
    dom.statSuccessDetail.textContent = `${formatCompact(successes)} successful call${plural(successes)}`;
    dom.statSuccessTrend.textContent = !requests ? "Ready" : successRate >= 95 ? "Healthy" : successRate >= 75 ? "Monitor" : "Review";

    dom.statCooldown.textContent = String(cooling);
    dom.statCooldownDetail.textContent = cooling ? `${cooling} key${plural(cooling)} resting` : "No keys resting";
    dom.statCooldownTrend.textContent = cooling ? "Waiting" : "Clear";

    dom.heroAvailableCount.textContent = `${ready} key${plural(ready)}`;
    dom.heroCapacity.textContent = `${total} / ${state.maxKeys}`;
    dom.studioStatusText.textContent = !total
      ? "Add a key to begin"
      : ready
        ? "Ready to stream"
        : cooling
          ? "All keys cooling down"
          : "No keys available";
    dom.studioStatus.classList.toggle("attention", total > 0 && ready === 0);

    dom.voiceChangerStatusText.textContent = !total
      ? "Add a key to begin"
      : ready
        ? "Ready to convert"
        : cooling
          ? "All keys cooling down"
          : "No keys available";
    dom.voiceChangerStudioStatus.classList.toggle("attention", total > 0 && ready === 0);
  }

  function updateCapacityLabels() {
    const total = state.keys.length;
    const percent = Math.min(100, (total / state.maxKeys) * 100);
    dom.poolCount.textContent = `${total} / ${state.maxKeys}`;
    dom.heroCapacity.textContent = `${total} / ${state.maxKeys}`;
    dom.capacityBar.style.width = `${percent}%`;
    dom.capacityTrack.setAttribute("aria-valuemax", String(state.maxKeys));
    dom.capacityTrack.setAttribute("aria-valuenow", String(total));
    dom.capacityTrack.setAttribute("aria-valuetext", `${total} of ${state.maxKeys} slots used`);
    dom.capacityText.textContent = `${total} of ${state.maxKeys} slot${plural(total)} used`;
    renderStats();
    renderActionAvailability();
  }

  function renderActionAvailability() {
    const hasKeys = state.keys.length > 0;
    const hasReadyKey = state.keys.some((key) => getVisualStatus(key).kind === "ready");
    dom.resetKeysButton.disabled = !hasKeys || dom.resetKeysButton.dataset.busy === "true";
    dom.clearKeysButton.disabled = !hasKeys || dom.clearKeysButton.dataset.busy === "true";
    dom.generateButton.disabled = !state.ttsController && (!hasReadyKey || !isTtsInputReady());
    dom.convertVoiceButton.disabled = !state.voiceChangerController && (
      !hasReadyKey || !isVoiceChangerInputReady()
    );
  }

  function updateCooldownCountdowns() {
    if (state.authMode) return;
    const cards = dom.keyGrid.querySelectorAll(".key-card");
    state.keys.forEach((key, index) => {
      const card = cards[index];
      if (!card) return;
      const cooldownNode = card.querySelector('[data-role="cooldown"]');
      const statusText = card.querySelector('[data-role="status-text"]');
      const remaining = getCooldownRemaining(key.cooldownUntil);
      if (cooldownNode) {
        cooldownNode.textContent = remaining > 0 ? `${formatDuration(remaining)} remaining` : "No active cooldown";
      }
      if (statusText && getVisualStatus(key).kind === "cooldown") {
        statusText.textContent = remaining > 0 ? `${Math.ceil(remaining / 1000)}s` : "Checking";
      }
    });
  }

  function detectKeyChanges() {
    if (!state.hasSnapshot) return;

    let requestsAdded = 0;
    let successesAdded = 0;

    state.keys.forEach((key) => {
      const id = keyIdentifier(key);
      const previous = state.snapshots.get(id);
      if (!previous) {
        if (state.hasSnapshot && state.snapshots.size) {
          addEvent("Key detected", `${key.label || `Key ${id}`} joined the routing pool.`, "info");
        }
        return;
      }

      const nextRequests = toCount(key.requestCount);
      const previousRequests = toCount(previous.requestCount);
      const nextSuccesses = toCount(key.successCount);
      const previousSuccesses = toCount(previous.successCount);
      if (nextRequests >= previousRequests) {
        requestsAdded += nextRequests - previousRequests;
        successesAdded += Math.max(0, nextSuccesses - previousSuccesses);
      }

      const oldVisual = getVisualStatus(previous);
      const newVisual = getVisualStatus(key);
      if (newVisual.kind !== oldVisual.kind) {
        if (newVisual.kind === "cooldown") {
          addEvent(
            "Key entered cooldown",
            `${key.label || `Key ${id}`}${key.lastError ? ` · ${truncate(String(key.lastError), 72)}` : " · rate limit detected"}.`,
            "warning",
          );
        } else if (oldVisual.kind === "cooldown" && newVisual.kind === "ready") {
          addEvent("Key recovered", `${key.label || `Key ${id}`} is ready to route again.`, "success");
        } else {
          addEvent("Key status changed", `${key.label || `Key ${id}`} is now ${newVisual.label.toLowerCase()}.`, newVisual.kind === "unavailable" ? "error" : "info");
        }
      }
    });

    state.snapshots.forEach((previous, id) => {
      if (!state.keys.some((key) => keyIdentifier(key) === id)) {
        addEvent("Key removed", `${previous.label || `Key ${id}`} left the routing pool.`, "warning");
      }
    });

    if (requestsAdded > 0) {
      addEvent("Traffic routed", `+${formatCompact(requestsAdded)} request${plural(requestsAdded)} · ${formatCompact(successesAdded)} successful.`, "success");
    }
  }

  function makeSnapshots(keys) {
    const snapshots = new Map();
    keys.forEach((key) => {
      snapshots.set(keyIdentifier(key), {
        id: key.id,
        label: key.label,
        status: key.status,
        cooldownUntil: key.cooldownUntil,
        requestCount: toCount(key.requestCount),
        successCount: toCount(key.successCount),
        lastError: key.lastError,
      });
    });
    return snapshots;
  }

  function keySnapshotSignature(keys) {
    return JSON.stringify([...makeSnapshots(keys).entries()]);
  }

  function normalizeKeySnapshot(data) {
    if (!isRecord(data) || !Array.isArray(data.keys)) {
      throw new Error("Router returned an invalid key snapshot.");
    }
    if (!Number.isInteger(data.maxKeys) || data.maxKeys < 1 || data.maxKeys > 10) {
      throw new Error("Router returned an invalid key capacity.");
    }
    if (data.keys.length > data.maxKeys) {
      throw new Error("Router returned more keys than its declared capacity.");
    }

    const ids = new Set();
    const keys = data.keys.map((key) => {
      if (!isRecord(key) || typeof key.id !== "string" || !key.id.trim() || key.id.length > 128) {
        throw new Error("Router returned an invalid key record.");
      }
      if (ids.has(key.id)) throw new Error("Router returned duplicate key records.");
      ids.add(key.id);
      if (typeof key.maskedKey !== "string" || key.maskedKey.length > 128) {
        throw new Error("Router returned an invalid masked key.");
      }
      if (!["active", "cooldown", "disabled"].includes(key.status)) {
        throw new Error("Router returned an invalid key status.");
      }
      if (!Number.isInteger(key.requestCount) || key.requestCount < 0 || !Number.isInteger(key.successCount) || key.successCount < 0) {
        throw new Error("Router returned invalid key counters.");
      }

      return {
        id: key.id,
        label: typeof key.label === "string" ? key.label.slice(0, 128) : "",
        maskedKey: key.maskedKey,
        status: key.status,
        cooldownUntil: normalizeTimestamp(key.cooldownUntil, "cooldownUntil"),
        lastUsedAt: normalizeTimestamp(key.lastUsedAt, "lastUsedAt"),
        requestCount: key.requestCount,
        successCount: key.successCount,
        lastError: key.lastError == null ? null : String(key.lastError).slice(0, 256),
      };
    });

    const stats = {
      total: keys.length,
      available: keys.filter((key) => key.status === "active").length,
      coolingDown: keys.filter((key) => key.status === "cooldown").length,
      disabled: keys.filter((key) => key.status === "disabled").length,
    };
    return { keys, stats, maxKeys: data.maxKeys };
  }

  function normalizeTimestamp(value, field) {
    if (value == null || value === "") return null;
    if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) {
      throw new Error(`Router returned an invalid ${field}.`);
    }
    return value;
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function getVisualStatus(key) {
    const raw = String(key.status || "unknown").toLowerCase().replace(/[_\s-]+/g, " ");
    const remaining = getCooldownRemaining(key.cooldownUntil);

    if (remaining > 0 || raw.includes("cool") || raw.includes("rate limit")) {
      return { kind: "cooldown", label: "Cooling down", shortLabel: "Cooling" };
    }
    if (raw.includes("exhaust") || raw.includes("disabled") || raw.includes("invalid") || raw.includes("blocked") || raw.includes("unavailable") || raw.includes("error")) {
      return { kind: "unavailable", label: "Unavailable", shortLabel: "Unavailable" };
    }
    if (raw.includes("ready") || raw.includes("active") || raw.includes("available") || raw.includes("healthy") || raw.includes("ok")) {
      return { kind: "ready", label: "Ready", shortLabel: "Ready" };
    }
    return { kind: "unknown", label: toTitleCase(raw), shortLabel: "Unknown" };
  }

  function getCooldownRemaining(value) {
    if (!value) return 0;
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return 0;
    return Math.max(0, timestamp - Date.now());
  }

  /* TTS */
  async function generateSpeech(event) {
    event.preventDefault();
    if (state.ttsController) {
      state.ttsController.abort();
      return;
    }

    const text = dom.ttsText.value.trim();
    const voiceId = dom.voiceId.value.trim();
    if (!text || !voiceId) {
      setTtsStatus("error", "Text and voice ID are required", "Add both fields before generating speech.");
      (!text ? dom.ttsText : dom.voiceId).focus();
      return;
    }

    const characterCount = countCharacters(text);
    const characterLimit = getModelLimit();
    if (characterCount > characterLimit) {
      setTtsStatus("error", "Text is too long", `${dom.modelId.options[dom.modelId.selectedIndex].text} accepts up to ${characterLimit.toLocaleString()} characters.`);
      return;
    }

    const controller = new AbortController();
    state.ttsController = controller;
    setGenerating(true);
    setTtsStatus("working", "Opening audio stream", "The router will move past unavailable keys automatically.");
    showDownloadProgress(null);

    try {
      const response = await authenticatedFetch("/api/tts", {
        method: "POST",
        headers: { Accept: "audio/*, application/json" },
        body: JSON.stringify({
          text,
          voiceId,
          modelId: dom.modelId.value,
          outputFormat: dom.outputFormat.value,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let data = {};
        try { data = JSON.parse(errorText); } catch { data = { message: errorText }; }
        throw new Error(getApiMessage(data, `Speech generation failed (${response.status}).`));
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!isAudioResponseContentType(contentType)) {
        const textBody = await response.text();
        let data = {};
        try { data = JSON.parse(textBody); } catch { data = { message: textBody }; }
        throw new Error(getApiMessage(data, "The server did not return audio."));
      }

      setTtsStatus("working", "Receiving audio", "Streaming the generated speech into your player…");
      const audioBlob = await readResponseBlob(
        response,
        (received, total) => showDownloadProgress(total ? { received, total } : null),
        contentType || contentTypeForOutput(dom.outputFormat.value),
      );
      if (!audioBlob.size) {
        throw new Error("The server returned an empty audio response.");
      }

      revokeAudioUrl();
      state.audioUrl = URL.createObjectURL(audioBlob);
      dom.audioPlayer.src = state.audioUrl;
      dom.audioPlayer.load();
      updateAudioExtension();
      dom.audioResult.hidden = false;
      dom.audioResultMeta.textContent = `${formatBytes(audioBlob.size)} · generated just now`;
      setTtsStatus("success", "Speech generated", `${formatBytes(audioBlob.size)} of audio is ready to play or download.`);
      addEvent("Speech generated", `${formatBytes(audioBlob.size)} streamed successfully through KeyFlow.`, "success");
      showToast("Your audio is ready.", "success");
      await loadKeys({ silent: true, fresh: true }).catch(() => undefined);
    } catch (error) {
      if (error.name === "AbortError") {
        setTtsStatus("idle", "Generation cancelled", "No audio was created. The key pool is still ready.");
        addEvent("Generation cancelled", "The active speech request was cancelled.", "warning");
      } else {
        setTtsStatus("error", "Generation failed", error.message || "The server could not generate audio.");
        addEvent("Speech request failed", truncate(error.message || "Unknown server error", 110), "error");
        showToast(error.message || "Speech generation failed.", "error");
      }
      await loadKeys({ silent: true, fresh: true }).catch(() => undefined);
    } finally {
      state.ttsController = null;
      setGenerating(false);
      window.setTimeout(() => {
        if (!state.ttsController) dom.downloadProgress.hidden = true;
      }, 900);
    }
  }

  async function readResponseBlob(response, onProgress, type) {
    const total = Number(response.headers.get("content-length")) || 0;
    if (!response.body?.getReader) {
      const buffer = await response.arrayBuffer();
      onProgress(buffer.byteLength, total);
      return new Blob([buffer], { type: type || "application/octet-stream" });
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          chunks.push(value);
          received += value.byteLength;
          onProgress(received, total);
        }
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // The original read error is more useful to the caller.
      }
      throw error;
    }

    onProgress(received, total);
    return new Blob(chunks, { type: type || "application/octet-stream" });
  }

  function setGenerating(generating) {
    dom.ttsForm.setAttribute("aria-busy", String(generating));
    dom.generateButton.classList.toggle("generating", generating);
    dom.generateButton.setAttribute("aria-label", generating ? "Cancel speech generation" : "Generate speech");
    dom.generateButtonText.textContent = generating ? "Cancel generation" : "Generate speech";
    dom.generateButton.disabled = !generating && (
      !state.keys.some((key) => getVisualStatus(key).kind === "ready") || !isTtsInputReady()
    );
  }

  function setTtsStatus(kind, title, detail) {
    const icon = dom.ttsFeedback.querySelector(".status-icon");
    const titleNode = dom.ttsFeedback.querySelector("strong");
    const detailNode = dom.ttsFeedback.querySelector("small");
    icon.className = `status-icon ${kind === "working" ? "working" : kind === "error" ? "error" : kind === "success" ? "success" : "idle"}`;
    titleNode.textContent = title;
    detailNode.textContent = detail;
  }

  function showDownloadProgress(progress) {
    if (!progress) {
      dom.downloadProgress.hidden = false;
      dom.downloadProgressLabel.textContent = "Receiving audio";
      dom.downloadProgressValue.textContent = "Live";
      dom.audioProgress.removeAttribute("value");
      return;
    }

    const percent = progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
    dom.downloadProgress.hidden = false;
    dom.downloadProgressLabel.textContent = `Receiving audio · ${formatBytes(progress.received)}`;
    dom.downloadProgressValue.textContent = progress.total ? `${percent}%` : "Live";
    if (progress.total) dom.audioProgress.value = percent;
    else dom.audioProgress.removeAttribute("value");
  }

  function updateAudioExtension() {
    const extension = extensionForOutput(dom.outputFormat.value);
    if (state.audioUrl) dom.downloadAudio.href = state.audioUrl;
    const date = new Date().toISOString().slice(0, 10);
    dom.downloadAudio.download = `keyflow-speech-${date}.${extension}`;
  }

  function revokeAudioUrl() {
    if (state.audioUrl) {
      URL.revokeObjectURL(state.audioUrl);
      state.audioUrl = null;
    }
  }

  function updateTtsLimit() {
    const limit = getModelLimit();
    dom.ttsText.maxLength = String(limit);
    dom.ttsTextHelp.textContent = `Up to ${limit.toLocaleString()} characters for ${dom.modelId.options[dom.modelId.selectedIndex].text.split(" · ")[0]}.`;
    updateTtsCount();
  }

  function updateTtsCount() {
    const count = countCharacters(dom.ttsText.value);
    const limit = getModelLimit();
    const tooLong = count > limit;
    dom.ttsCharacterCount.textContent = `${count.toLocaleString()} / ${limit.toLocaleString()} characters`;
    dom.ttsCharacterCount.classList.toggle("over-limit", tooLong);
    dom.ttsText.setAttribute("aria-invalid", String(tooLong));
    dom.ttsText.setCustomValidity(tooLong ? `Text exceeds the ${limit.toLocaleString()} character limit for this model.` : "");
    renderActionAvailability();
  }

  function getModelLimit() {
    return MODEL_LIMITS[dom.modelId.value] || 5000;
  }

  function isTtsInputReady() {
    const text = dom.ttsText.value.trim();
    return Boolean(text && dom.voiceId.value.trim() && countCharacters(text) <= getModelLimit());
  }

  function countCharacters(value) {
    return Array.from(value).length;
  }

  /* Voice changer */
  function handleSourceAudioChange() {
    setVoiceChangerFile(dom.sourceAudio.files?.[0] || null);
  }

  function setVoiceChangerFile(file) {
    revokeVoiceChangerUrl();
    dom.voiceChangerResult.hidden = true;
    dom.voiceChangerProgress.hidden = true;
    dom.voiceUploadDropzone.classList.remove("has-file", "is-dragging");
    dom.sourceAudio.setAttribute("aria-invalid", "false");
    state.voiceChangerFile = null;
    dom.sourceAudioName.textContent = "Choose an audio file";
    dom.sourceAudioSize.textContent = "No file selected";

    if (!file) {
      setVoiceChangerStatus("idle", "Ready", "Select an audio file to start a conversion.");
      renderActionAvailability();
      return;
    }

    const validationMessage = validateAudioFile(file);
    if (validationMessage) {
      dom.sourceAudio.value = "";
      dom.sourceAudio.setAttribute("aria-invalid", "true");
      setVoiceChangerStatus("error", "File not accepted", validationMessage);
      renderActionAvailability();
      return;
    }

    state.voiceChangerFile = file;
    dom.voiceUploadDropzone.classList.add("has-file");
    dom.sourceAudioName.textContent = file.name;
    dom.sourceAudioSize.textContent = formatBytes(file.size);
    setVoiceChangerStatus(
      "idle",
      "File ready",
      `${formatBytes(file.size)} selected. Choose a target voice and convert when ready.`,
    );
    renderActionAvailability();
  }

  function validateAudioFile(file) {
    const type = String(file.type || "").toLowerCase();
    const name = String(file.name || "").toLowerCase();
    const hasAudioType = type.startsWith("audio/") || type === "application/octet-stream";
    const hasSupportedExtension = SUPPORTED_AUDIO_EXTENSIONS.some((extension) => name.endsWith(extension));
    if (!hasAudioType && !hasSupportedExtension) {
      return "Choose an MP3, WAV, M4A, OGG, FLAC, AAC, Opus, or WebM audio file.";
    }
    if (!file.size) {
      return "The selected audio file is empty.";
    }
    if (file.size > MAX_VOICE_FILE_BYTES) {
      return "The selected file is larger than the 50 MB upload limit.";
    }
    return "";
  }

  function handleAudioDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    dom.voiceUploadDropzone.classList.add("is-dragging");
  }

  function handleAudioDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!dom.voiceUploadDropzone.contains(event.relatedTarget)) {
      dom.voiceUploadDropzone.classList.remove("is-dragging");
    }
  }

  function handleAudioDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    dom.voiceUploadDropzone.classList.remove("is-dragging");
    const file = event.dataTransfer?.files?.[0] || null;
    if (file) setVoiceChangerFile(file);
  }

  async function convertVoice(event) {
    event.preventDefault();
    if (state.voiceChangerController) {
      state.voiceChangerController.abort();
      return;
    }

    const file = state.voiceChangerFile;
    const voiceId = dom.voiceChangerVoiceId.value.trim();
    if (!file || !voiceId) {
      setVoiceChangerStatus(
        "error",
        "Source audio and target voice are required",
        !file ? "Choose an audio file before converting." : "Enter a target voice ID before converting.",
      );
      (!file ? dom.sourceAudio : dom.voiceChangerVoiceId).focus();
      return;
    }

    const controller = new AbortController();
    state.voiceChangerController = controller;
    setVoiceConverting(true);
    setVoiceChangerStatus("working", "Opening conversion stream", "The router will move past unavailable keys automatically.");
    showVoiceDownloadProgress(null);

    try {
      const query = new URLSearchParams({
        voiceId,
        modelId: dom.voiceChangerModelId.value,
        outputFormat: dom.voiceChangerOutputFormat.value,
        removeBackgroundNoise: String(dom.removeBackgroundNoise.checked),
      });
      const response = await authenticatedFetch(`/api/voice-changer?${query.toString()}`, {
        method: "POST",
        headers: {
          Accept: "audio/*, application/json",
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let data = {};
        try { data = JSON.parse(errorText); } catch { data = { message: errorText }; }
        throw new Error(getApiMessage(data, `Voice conversion failed (${response.status}).`));
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!isAudioResponseContentType(contentType)) {
        const textBody = await response.text();
        let data = {};
        try { data = JSON.parse(textBody); } catch { data = { message: textBody }; }
        throw new Error(getApiMessage(data, "The server did not return converted audio."));
      }

      setVoiceChangerStatus("working", "Receiving converted audio", "Streaming the transformed voice into your player…");
      const audioBlob = await readResponseBlob(
        response,
        (received, total) => showVoiceDownloadProgress(total ? { received, total } : null),
        contentType || contentTypeForOutput(dom.voiceChangerOutputFormat.value),
      );
      if (!audioBlob.size) {
        throw new Error("The server returned an empty audio response.");
      }

      revokeVoiceChangerUrl();
      state.voiceChangerUrl = URL.createObjectURL(audioBlob);
      dom.voiceChangerPlayer.src = state.voiceChangerUrl;
      dom.voiceChangerPlayer.load();
      updateVoiceAudioExtension();
      dom.voiceChangerResult.hidden = false;
      dom.voiceChangerResultMeta.textContent = `${formatBytes(audioBlob.size)} · converted just now`;
      setVoiceChangerStatus("success", "Voice converted", `${formatBytes(audioBlob.size)} is ready to play or download.`);
      addEvent("Voice converted", `${file.name} transformed successfully through KeyFlow.`, "success");
      showToast("Converted audio is ready.", "success");
      await loadKeys({ silent: true, fresh: true }).catch(() => undefined);
    } catch (error) {
      if (error.name === "AbortError") {
        setVoiceChangerStatus("idle", "Conversion cancelled", "No converted audio was created. The key pool is still ready.");
        addEvent("Voice conversion cancelled", "The active conversion was cancelled.", "warning");
      } else {
        setVoiceChangerStatus("error", "Conversion failed", error.message || "The server could not convert this file.");
        addEvent("Voice conversion failed", truncate(error.message || "Unknown server error", 110), "error");
        showToast(error.message || "Voice conversion failed.", "error");
      }
      await loadKeys({ silent: true, fresh: true }).catch(() => undefined);
    } finally {
      state.voiceChangerController = null;
      setVoiceConverting(false);
      window.setTimeout(() => {
        if (!state.voiceChangerController) dom.voiceChangerProgress.hidden = true;
      }, 900);
    }
  }

  function setVoiceConverting(converting) {
    dom.voiceChangerForm.setAttribute("aria-busy", String(converting));
    dom.convertVoiceButton.classList.toggle("generating", converting);
    dom.convertVoiceButton.setAttribute("aria-label", converting ? "Cancel voice conversion" : "Convert voice");
    dom.convertVoiceButtonText.textContent = converting ? "Cancel conversion" : "Convert voice";
    dom.convertVoiceButton.disabled = !converting && (
      !state.keys.some((key) => getVisualStatus(key).kind === "ready") || !isVoiceChangerInputReady()
    );
    renderActionAvailability();
  }

  function setVoiceChangerStatus(kind, title, detail) {
    const icon = dom.voiceChangerFeedback.querySelector(".status-icon");
    const titleNode = dom.voiceChangerFeedback.querySelector("strong");
    const detailNode = dom.voiceChangerFeedback.querySelector("small");
    icon.className = `status-icon ${kind === "working" ? "working" : kind === "error" ? "error" : kind === "success" ? "success" : "idle"}`;
    titleNode.textContent = title;
    detailNode.textContent = detail;
  }

  function showVoiceDownloadProgress(progress) {
    if (!progress) {
      dom.voiceChangerProgress.hidden = false;
      dom.voiceChangerProgressLabel.textContent = "Receiving converted audio";
      dom.voiceChangerProgressValue.textContent = "Live";
      dom.voiceChangerAudioProgress.removeAttribute("value");
      return;
    }

    const percent = progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
    dom.voiceChangerProgress.hidden = false;
    dom.voiceChangerProgressLabel.textContent = `Receiving converted audio · ${formatBytes(progress.received)}`;
    dom.voiceChangerProgressValue.textContent = progress.total ? `${percent}%` : "Live";
    if (progress.total) dom.voiceChangerAudioProgress.value = percent;
    else dom.voiceChangerAudioProgress.removeAttribute("value");
  }

  function updateVoiceAudioExtension() {
    const extension = extensionForOutput(dom.voiceChangerOutputFormat.value);
    if (state.voiceChangerUrl) dom.downloadConvertedAudio.href = state.voiceChangerUrl;
    const date = new Date().toISOString().slice(0, 10);
    dom.downloadConvertedAudio.download = `keyflow-voice-changer-${date}.${extension}`;
  }

  function revokeVoiceChangerUrl() {
    if (state.voiceChangerUrl) {
      URL.revokeObjectURL(state.voiceChangerUrl);
      state.voiceChangerUrl = null;
    }
  }

  function isVoiceChangerInputReady() {
    return Boolean(
      state.voiceChangerFile &&
      dom.voiceChangerVoiceId.value.trim() &&
      state.voiceChangerFile.size > 0 &&
      state.voiceChangerFile.size <= MAX_VOICE_FILE_BYTES
    );
  }

  function isAudioResponseContentType(value) {
    if (!value) return true;
    const contentType = value.split(";", 1)[0].trim();
    return contentType.startsWith("audio/") || contentType === "application/octet-stream" || contentType === "application/wav";
  }

  /* Events */
  function addEvent(title, detail = "", tone = "info") {
    const event = { id: `${Date.now()}-${Math.random()}`, title, detail, tone, at: new Date() };
    state.events.unshift(event);
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
    renderEvents();
  }

  function renderEvents() {
    dom.eventList.replaceChildren();
    dom.eventTotal.textContent = String(state.events.length);

    if (!state.events.length) {
      const empty = document.createElement("li");
      empty.className = "event-empty";
      empty.textContent = "Router events will appear here.";
      dom.eventList.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    state.events.forEach((event) => {
      const item = document.createElement("li");
      item.className = `event-item ${event.tone}`;

      const marker = document.createElement("span");
      marker.className = "event-marker";
      marker.setAttribute("aria-hidden", "true");

      const copy = document.createElement("span");
      copy.className = "event-copy";
      const title = document.createElement("strong");
      title.textContent = event.title;
      copy.append(title);
      if (event.detail) {
        const detail = document.createElement("p");
        detail.textContent = event.detail;
        copy.append(detail);
      }

      const time = document.createElement("time");
      time.className = "event-time";
      time.dateTime = event.at.toISOString();
      time.textContent = formatClock(event.at);

      item.append(marker, copy, time);
      fragment.append(item);
    });
    dom.eventList.append(fragment);
  }

  function clearEvents() {
    state.events = [];
    renderEvents();
    addEvent("Event log cleared", "New router activity will appear here.", "info");
  }

  /* Small UI helpers */
  function setSyncState(status, label) {
    state.connection = status;
    dom.connectionPill.className = `connection-pill ${status}`;
    dom.connectionText.textContent = label;
    if (dom.syncStatus && dom.keyGrid?.getAttribute("aria-busy") !== "true") {
      dom.syncStatus.className = `sync-status ${status === "syncing" || status === "checking" ? "syncing" : status === "error" || status === "offline" ? "error" : "synced"}`;
    }
  }

  function updateSyncTime() {
    dom.lastSync.textContent = `Synced ${formatClock(new Date())}`;
    dom.syncStatus.className = "sync-status synced";
  }

  function setKeyFeedback(message, tone = "") {
    dom.keyFeedback.textContent = message;
    dom.keyFeedback.className = `form-feedback ${tone}`.trim();
  }

  function parseKeyInput(value) {
    const unique = [];
    const seen = new Set();
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((key) => {
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(key);
        }
      });
    return unique;
  }

  function updateParsedCount() {
    const secureTransport = isCredentialTransportSecure();
    const count = parseKeyInput(dom.keyInput.value).length;
    dom.parsedKeyCount.textContent = `${count} detected`;
    dom.keyInput.disabled = !secureTransport;
    const full = state.keys.length >= state.maxKeys;
    dom.addKeysButton.disabled = !secureTransport || full || dom.addKeysButton.dataset.busy === "true";
    if (!secureTransport) {
      setKeyFeedback("Use HTTPS before sending ElevenLabs keys to this dashboard.", "error");
    } else if (full && dom.keyInput.value.trim()) {
      setKeyFeedback(`The pool is full at ${state.maxKeys} keys.`, "error");
    }
  }

  function openClearDialog() {
    if (!state.keys.length) return;
    dom.clearDialog.showModal();
    window.setTimeout(() => dom.clearCancelButton.focus(), 40);
  }

  function closeClearDialog() {
    if (dom.clearDialog.open) dom.clearDialog.close();
  }

  function setButtonBusy(button, busy, label = "") {
    if (!button) return;
    if (busy) {
      button.dataset.busy = "true";
      if (!button.__keyFlowContent) {
        button.__keyFlowContent = Array.from(button.childNodes, (node) => node.cloneNode(true));
      }
      button.replaceChildren(document.createTextNode(label));
      button.disabled = true;
    } else {
      button.dataset.busy = "false";
      if (button.__keyFlowContent) {
        button.replaceChildren(...button.__keyFlowContent.map((node) => node.cloneNode(true)));
      }
      button.disabled = false;
    }
    updateParsedCount();
    renderActionAvailability();
  }

  function showToast(message, tone = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${tone}`;
    toast.textContent = message;
    dom.toastRegion.append(toast);
    window.setTimeout(() => {
      toast.classList.add("leaving");
      window.setTimeout(() => toast.remove(), 200);
    }, 3600);
  }

  function keyIdentifier(key, fallback = 0) {
    return String(key.id ?? key.label ?? fallback);
  }

  function toCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function plural(value) {
    return Number(value) === 1 ? "" : "s";
  }

  function toTitleCase(value) {
    return value ? value.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unknown";
  }

  function truncate(value, max) {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function formatCompact(value) {
    return new Intl.NumberFormat(undefined, { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** index;
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  }

  function formatRelativeTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    const timestamp = date.getTime();
    if (!Number.isFinite(timestamp)) return "recently";
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const absolute = Math.abs(seconds);
    if (absolute < 10) return "just now";
    if (absolute < 60) return `${absolute}s ago`;
    if (absolute < 3600) return `${Math.floor(absolute / 60)}m ago`;
    if (absolute < 86400) return `${Math.floor(absolute / 3600)}h ago`;
    if (absolute < 604800) return `${Math.floor(absolute / 86400)}d ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatClock(date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }

  function extensionForOutput(format) {
    if (String(format).startsWith("mp3")) return "mp3";
    if (String(format).startsWith("ulaw")) return "wav";
    if (String(format).startsWith("pcm")) return "pcm";
    return "audio";
  }

  function contentTypeForOutput(format) {
    if (String(format).startsWith("mp3")) return "audio/mpeg";
    if (String(format).startsWith("ulaw")) return "audio/wav";
    if (String(format).startsWith("pcm")) return "audio/L16";
    return "application/octet-stream";
  }
})();
