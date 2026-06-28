const TRANSLATION_CLASS = "avision-translator-translation";
const SELECTION_POPUP_CLASS = "avision-translator-selection-popup";
const TRANSLATED_ATTR = "data-avision-translated";
const CACHE_PREFIX = "v1:";
const YOUTUBE_LATE_RESULT_GRACE_MS = 2500;
const YOUTUBE_POLL_MS = 250;
const YOUTUBE_STABLE_DELAY_MS = 220;
const YOUTUBE_VISIBLE_STALE_MS = 1400;
const YOUTUBE_TRACK_POLL_MS = 250;
const YOUTUBE_TRACK_INITIAL_LIMIT = 40;
const YOUTUBE_TRACK_BACKGROUND_BATCH_SIZE = 60;

let pageVisible = true;
let youtubeCaptionObserver = null;
let youtubeLastCaption = "";
let youtubeCaptionMissingSince = 0;
let youtubeLastSeenAt = 0;
let youtubePendingCaption = "";
let youtubePendingTimer = null;
let youtubePollTimer = null;
let youtubeRequestId = 0;
let youtubeTrackMode = null;
let youtubeTrackTimer = null;
let youtubeTrackBackgroundRunning = false;
let pageTranslationCancelRequested = false;
const memoryCache = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleContentMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleContentMessage(message) {
  if (message?.type === "ping") {
    return { ok: true };
  }

  if (message?.type === "translatePage") {
    const settings = await requestSettings();
    const summary = await translatePage(settings);
    return { ok: true, summary };
  }

  if (message?.type === "cancelPageTranslation") {
    pageTranslationCancelRequested = true;
    return { ok: true };
  }

  if (message?.type === "toggleTranslations") {
    pageVisible = !pageVisible;
    document.documentElement.classList.toggle("avision-translator-hidden", !pageVisible);
    return { ok: true, visible: pageVisible };
  }

  if (message?.type === "clearTranslations") {
    return { ok: true, summary: clearPageTranslations() };
  }

  if (message?.type === "translateSelection") {
    return { ok: true, summary: await translateSelection() };
  }

  if (message?.type === "startYoutubeCaptions") {
    const summary = await startYoutubeCaptionTranslation();
    return { ok: true, summary };
  }

  return { ok: false, error: `Unknown content message: ${message?.type}` };
}

async function requestSettings() {
  const response = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not load settings");
  }
  return response.settings;
}

async function translatePage(settings) {
  pageTranslationCancelRequested = false;
  const nodes = findTranslatableNodes();
  const maxCharacters = Number(settings.maxCharactersPerPage || 60000);
  let usedCharacters = 0;
  let translated = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  if (!nodes.length) {
    return {
      translated,
      skipped,
      failed,
      characters: usedCharacters,
      reason: "No readable paragraph text was found on this page."
    };
  }

  postPageTranslationProgress({ translated, skipped, failed, processed, total: nodes.length, phase: "started" });

  for (const node of nodes) {
    if (pageTranslationCancelRequested) {
      postPageTranslationProgress({ translated, skipped, failed, processed, total: nodes.length, phase: "cancelled" });
      break;
    }

    const text = normalizeText(node.innerText);
    if (!text || node.getAttribute(TRANSLATED_ATTR) === "true") {
      skipped += 1;
      processed += 1;
      postPageTranslationProgress({ translated, skipped, failed, processed, total: nodes.length, phase: "running" });
      continue;
    }

    if (usedCharacters + text.length > maxCharacters) {
      skipped += 1;
      processed += 1;
      postPageTranslationProgress({ translated, skipped, failed, processed, total: nodes.length, phase: "running" });
      continue;
    }

    usedCharacters += text.length;
    const placeholder = insertTranslation(node, "Translating...");

    try {
      const result = await translateWithCache(text);
      placeholder.textContent = result.translatedText;
      placeholder.dataset.provider = result.provider;
      node.setAttribute(TRANSLATED_ATTR, "true");
      translated += 1;
    } catch (error) {
      placeholder.textContent = `Translation failed: ${error.message || error}`;
      placeholder.classList.add("avision-translator-error");
      failed += 1;
    }

    processed += 1;
    postPageTranslationProgress({ translated, skipped, failed, processed, total: nodes.length, phase: "running" });
  }

  pageVisible = true;
  document.documentElement.classList.remove("avision-translator-hidden");
  const cancelled = pageTranslationCancelRequested;
  pageTranslationCancelRequested = false;
  postPageTranslationProgress({ translated, skipped, failed, processed, total: nodes.length, phase: cancelled ? "cancelled" : "done" });
  return {
    translated,
    skipped,
    failed,
    processed,
    total: nodes.length,
    characters: usedCharacters,
    cancelled,
    reason: translated ? "" : "No new paragraphs were translated. The page may already be translated or the text limit was reached."
  };
}

function postPageTranslationProgress(summary) {
  chrome.runtime.sendMessage({ type: "pageTranslationProgress", summary }).catch(() => {});
}

async function translateWithCache(text) {
  const key = `${CACHE_PREFIX}${stableHash(text)}`;
  if (memoryCache.has(key)) {
    return memoryCache.get(key);
  }

  const response = await chrome.runtime.sendMessage({ type: "translateText", text });
  if (!response?.ok) {
    throw new Error(response?.error || "Translation request failed");
  }

  memoryCache.set(key, response.result);
  return response.result;
}

async function translateBatchWithCache(texts) {
  const response = await chrome.runtime.sendMessage({ type: "translateBatch", texts });
  if (!response?.ok) {
    throw new Error(response?.error || "Batch translation request failed");
  }
  return response.results;
}

function findTranslatableNodes() {
  const root = findMainContentRoot();
  const selectors = [
    "p",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4"
  ];

  return Array.from(root.querySelectorAll(selectors.join(",")))
    .filter(isUsefulTextNode)
    .filter((node, index, list) => list.indexOf(node) === index);
}

function findMainContentRoot() {
  const direct = document.querySelector("article, main, [role='main']");
  if (direct && scoreContentRoot(direct) >= 120) {
    return direct;
  }

  const candidates = Array.from(document.querySelectorAll("article, main, [role='main'], section, .article, .post, .entry-content, .content, #content"))
    .filter((node) => !node.closest("nav,footer,header,aside"));

  let best = document.body;
  let bestScore = scoreContentRoot(document.body) * 0.45;
  for (const candidate of candidates) {
    const score = scoreContentRoot(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best || document.body;
}

function scoreContentRoot(node) {
  const paragraphs = Array.from(node.querySelectorAll("p, li, blockquote"));
  const textLength = normalizeText(node.innerText).length;
  const paragraphLength = paragraphs.reduce((total, item) => total + normalizeText(item.innerText).length, 0);
  return paragraphLength + paragraphs.length * 40 + Math.min(textLength, 2000) * 0.1;
}

function isUsefulTextNode(node) {
  if (!node || node.closest("script,style,noscript,code,pre,textarea,input,button,select,nav,footer,header,[contenteditable='true']")) {
    return false;
  }

  if (node.closest(`.${TRANSLATION_CLASS}`)) {
    return false;
  }

  const text = normalizeText(node.innerText);
  return text.length >= 20 && text.length <= 3000 && hasLetters(text);
}

function insertTranslation(node, text) {
  const existing = node.nextElementSibling;
  if (existing?.classList.contains(TRANSLATION_CLASS)) {
    existing.textContent = text;
    return existing;
  }

  const translation = document.createElement("div");
  translation.className = TRANSLATION_CLASS;
  translation.textContent = text;
  node.insertAdjacentElement("afterend", translation);
  return translation;
}

async function translateSelection() {
  const selection = window.getSelection();
  const text = normalizeText(selection?.toString());
  if (!text) {
    return { translated: false, reason: "Select text on the page first." };
  }

  if (text.length > 3000) {
    return { translated: false, reason: "Selection is too long. Select a smaller passage." };
  }

  const range = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const popup = showSelectionPopup("Translating selection...", range);

  try {
    const result = await translateWithCache(text);
    updateSelectionPopup(popup, result.translatedText);
    popup.dataset.provider = result.provider;
    return { translated: true, characters: text.length };
  } catch (error) {
    updateSelectionPopup(popup, `Translation failed: ${error.message || error}`);
    popup.classList.add("avision-translator-error");
    return { translated: false, reason: error.message || String(error) };
  }
}

function showSelectionPopup(text, range) {
  document.querySelector(`.${SELECTION_POPUP_CLASS}`)?.remove();
  const popup = document.createElement("div");
  popup.className = SELECTION_POPUP_CLASS;
  popup.innerHTML = `
    <div class="avision-selection-toolbar">
      <button type="button" class="avision-selection-copy">Copy</button>
      <button type="button" class="avision-selection-close">Close</button>
    </div>
    <div class="avision-selection-body"></div>
  `;
  updateSelectionPopup(popup, text);
  popup.querySelector(".avision-selection-close").addEventListener("click", () => popup.remove());
  popup.querySelector(".avision-selection-copy").addEventListener("click", async () => {
    const body = popup.querySelector(".avision-selection-body");
    await navigator.clipboard.writeText(body?.textContent || "");
  });
  document.body.appendChild(popup);

  const rect = range?.getBoundingClientRect();
  const top = Math.max(12, window.scrollY + (rect?.bottom || 0) + 8);
  const left = Math.min(
    window.scrollX + (rect?.left || 16),
    window.scrollX + document.documentElement.clientWidth - 340
  );
  popup.style.top = `${top}px`;
  popup.style.left = `${Math.max(12, left)}px`;
  return popup;
}

function updateSelectionPopup(popup, text) {
  const body = popup.querySelector(".avision-selection-body");
  if (body) {
    body.textContent = text;
  } else {
    popup.textContent = text;
  }
}

function clearPageTranslations() {
  const translations = Array.from(document.querySelectorAll(`.${TRANSLATION_CLASS}`));
  const selectionPopups = Array.from(document.querySelectorAll(`.${SELECTION_POPUP_CLASS}`));
  translations.forEach((node) => node.remove());
  selectionPopups.forEach((node) => node.remove());
  document.querySelectorAll(`[${TRANSLATED_ATTR}="true"]`).forEach((node) => {
    node.removeAttribute(TRANSLATED_ATTR);
  });
  document.documentElement.classList.remove("avision-translator-hidden");
  pageVisible = true;
  return { removed: translations.length + selectionPopups.length };
}

async function startYoutubeCaptionTranslation() {
  if (!location.hostname.includes("youtube.com")) {
    throw new Error("Open a YouTube video page before starting caption translation.");
  }

  const settings = await requestSettings();
  const mode = settings.youtubeMode || "auto";
  ensureYoutubeOverlay();

  if (mode === "live") {
    startYoutubeDomCaptionMode();
    return { mode: "youtubeDomCaptions", selectedMode: mode };
  }

  const trackSummary = await tryStartYoutubeTrackMode();
  if (trackSummary.ok) {
    return { ...trackSummary, selectedMode: mode };
  }

  if (mode === "track") {
    throw new Error(`YouTube caption track mode failed: ${trackSummary.error}`);
  }

  startYoutubeDomCaptionMode();
  return { mode: "youtubeDomCaptions", selectedMode: mode, fallbackReason: trackSummary.error };
}

function startYoutubeDomCaptionMode() {
  if (youtubeTrackMode) {
    return;
  }

  if (!youtubeCaptionObserver) {
    youtubeCaptionObserver = new MutationObserver(handleYoutubeCaptionMutation);
    youtubeCaptionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  if (!youtubePollTimer) {
    youtubePollTimer = window.setInterval(handleYoutubeCaptionMutation, YOUTUBE_POLL_MS);
  }

  handleYoutubeCaptionMutation();
}

async function tryStartYoutubeTrackMode() {
  try {
    const video = getYoutubeVideoElement();
    const videoId = getYoutubeVideoId();
    const track = chooseYoutubeCaptionTrack(getYoutubeCaptionTracks());
    if (!video || !videoId || !track) {
      return { ok: false, error: "No usable caption track found." };
    }

    const captions = await fetchYoutubeCaptionTrack(track);
    if (!captions.length) {
      return { ok: false, error: "Caption track was empty." };
    }

    const settings = await requestSettings();
    const initialCaptions = captions.slice(0, YOUTUBE_TRACK_INITIAL_LIMIT);
    const translatedCaptions = await translateYoutubeCaptionEntries(initialCaptions, videoId, track, settings);
    youtubeTrackMode = {
      video,
      videoId,
      track,
      settings,
      allCaptions: captions,
      captions: translatedCaptions,
      lastIndex: -1
    };

    if (!youtubeTrackTimer) {
      youtubeTrackTimer = window.setInterval(updateYoutubeTrackOverlay, YOUTUBE_TRACK_POLL_MS);
    }
    updateYoutubeTrackOverlay();
    translateRemainingYoutubeCaptionsInBackground();
    return {
      ok: true,
      mode: "youtubeTrack",
      captions: translatedCaptions.length,
      totalCaptions: captions.length,
      language: track.languageCode
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function translateRemainingYoutubeCaptionsInBackground() {
  if (!youtubeTrackMode || youtubeTrackBackgroundRunning) {
    return;
  }

  youtubeTrackBackgroundRunning = true;
  try {
    for (let start = youtubeTrackMode.captions.length; start < youtubeTrackMode.allCaptions.length; start += YOUTUBE_TRACK_BACKGROUND_BATCH_SIZE) {
      const batch = youtubeTrackMode.allCaptions.slice(start, start + YOUTUBE_TRACK_BACKGROUND_BATCH_SIZE);
      const translated = await translateYoutubeCaptionEntries(batch, youtubeTrackMode.videoId, youtubeTrackMode.track, youtubeTrackMode.settings);
      youtubeTrackMode.captions.splice(start, translated.length, ...translated);
    }
  } finally {
    youtubeTrackBackgroundRunning = false;
  }
}

function getYoutubeVideoElement() {
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

function getYoutubeVideoId() {
  return new URL(location.href).searchParams.get("v");
}

function getYoutubeCaptionTracks() {
  const response = window.ytInitialPlayerResponse;
  return response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
}

function chooseYoutubeCaptionTrack(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) {
    return null;
  }

  return tracks.find((track) => track.languageCode === "en" && !track.kind)
    || tracks.find((track) => track.languageCode === "en")
    || tracks.find((track) => !track.kind)
    || tracks[0];
}

async function fetchYoutubeCaptionTrack(track) {
  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", "json3");
  const response = await fetch(url.toString(), { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Caption track fetch failed (${response.status})`);
  }

  const data = await response.json();
  return parseYoutubeJson3Captions(data);
}

function parseYoutubeJson3Captions(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  return events
    .map((event) => {
      const text = normalizeText((event.segs || []).map((segment) => segment.utf8 || "").join(""));
      const start = Number(event.tStartMs || 0) / 1000;
      const duration = Number(event.dDurationMs || 0) / 1000;
      return { start, end: start + Math.max(duration, 0.8), text };
    })
    .filter((caption) => caption.text && hasLetters(caption.text));
}

async function translateYoutubeCaptionEntries(captions, videoId, track, settings) {
  const cacheKeys = captions.map((caption) => buildYoutubeCaptionCacheKey(videoId, track, caption, settings));
  const cached = await chrome.storage.local.get(cacheKeys);
  const output = new Array(captions.length);
  const missing = [];

  captions.forEach((caption, index) => {
    const cachedText = cached[cacheKeys[index]];
    if (cachedText) {
      output[index] = { ...caption, translatedText: cachedText };
      memoryCache.set(cacheKeys[index], { translatedText: cachedText, provider: "persistent-cache" });
    } else {
      missing.push({ caption, index, key: cacheKeys[index] });
    }
  });

  const batches = chunkArray(missing, 12);
  for (const batch of batches) {
    const results = await translateBatchWithCache(batch.map((item) => item.caption.text));
    const cacheWrites = {};
    results.forEach((result, resultIndex) => {
      const item = batch[resultIndex];
      const translatedText = result.translatedText || "";
      output[item.index] = { ...item.caption, translatedText };
      cacheWrites[item.key] = translatedText;
      memoryCache.set(item.key, result);
    });
    await chrome.storage.local.set(cacheWrites);
  }

  return output.filter(Boolean);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildYoutubeCaptionCacheKey(videoId, track, caption, settings) {
  const provider = settings.provider || "libretranslate";
  const target = settings.targetLanguage || "zh-Hant";
  return `yt:${videoId}:${track.languageCode || "unknown"}:${provider}:${target}:${Math.round(caption.start * 1000)}:${stableHash(caption.text)}`;
}

function updateYoutubeTrackOverlay() {
  if (!youtubeTrackMode?.video) {
    return;
  }

  const time = youtubeTrackMode.video.currentTime;
  const index = youtubeTrackMode.captions.findIndex((caption) => time >= caption.start && time <= caption.end);
  if (index < 0) {
    hideYoutubeOverlay();
    youtubeTrackMode.lastIndex = -1;
    return;
  }

  if (index === youtubeTrackMode.lastIndex) {
    return;
  }

  youtubeTrackMode.lastIndex = index;
  const overlay = ensureYoutubeOverlay();
  overlay.textContent = youtubeTrackMode.captions[index].translatedText;
  overlay.classList.remove("avision-youtube-caption-hidden", "avision-youtube-caption-error");
}

function handleYoutubeCaptionMutation() {
  const caption = getCurrentYoutubeCaption();
  if (!caption) {
    handleMissingYoutubeCaption();
    return;
  }

  youtubeCaptionMissingSince = 0;
  youtubeLastSeenAt = Date.now();
  window.setTimeout(clearStaleYoutubeOverlay, YOUTUBE_VISIBLE_STALE_MS + 100);

  if (caption === youtubeLastCaption) {
    return;
  }

  scheduleYoutubeCaptionTranslation(caption);
}

function scheduleYoutubeCaptionTranslation(caption) {
  youtubePendingCaption = caption;
  if (youtubePendingTimer) {
    window.clearTimeout(youtubePendingTimer);
  }

  youtubePendingTimer = window.setTimeout(() => {
    youtubePendingTimer = null;
    startYoutubeCaptionRequest(youtubePendingCaption);
  }, YOUTUBE_STABLE_DELAY_MS);
}

function startYoutubeCaptionRequest(caption) {
  if (!caption || caption === youtubeLastCaption) {
    return;
  }

  youtubeLastCaption = caption;
  youtubeCaptionMissingSince = 0;
  const requestId = ++youtubeRequestId;
  const overlay = ensureYoutubeOverlay();
  overlay.classList.remove("avision-youtube-caption-error");

  translateWithCache(caption)
    .then((result) => {
      if (canUseYoutubeCaptionResult(requestId, caption)) {
        overlay.textContent = result.translatedText;
        overlay.classList.remove("avision-youtube-caption-hidden");
        window.setTimeout(clearStaleYoutubeOverlay, YOUTUBE_VISIBLE_STALE_MS + 100);
      }
    })
    .catch((error) => {
      if (canUseYoutubeCaptionResult(requestId, caption)) {
        overlay.textContent = `Translation failed: ${error.message || error}`;
        overlay.classList.add("avision-youtube-caption-error");
        overlay.classList.remove("avision-youtube-caption-hidden");
      }
    });
}

function getCurrentYoutubeCaption() {
  const segments = Array.from(document.querySelectorAll(".ytp-caption-segment"));
  return normalizeText(segments.map((segment) => segment.textContent).join(" "));
}

function handleMissingYoutubeCaption() {
  if (youtubePendingTimer) {
    window.clearTimeout(youtubePendingTimer);
    youtubePendingTimer = null;
    youtubePendingCaption = "";
  }

  if (!youtubeLastCaption) {
    return;
  }

  if (!youtubeCaptionMissingSince) {
    youtubeCaptionMissingSince = Date.now();
  }

  window.setTimeout(clearStaleYoutubeOverlay, YOUTUBE_LATE_RESULT_GRACE_MS + 100);
}

function canUseYoutubeCaptionResult(requestId, caption) {
  if (requestId !== youtubeRequestId || youtubeLastCaption !== caption) {
    return false;
  }

  if (!youtubeCaptionMissingSince) {
    return true;
  }

  return Date.now() - youtubeCaptionMissingSince <= YOUTUBE_LATE_RESULT_GRACE_MS;
}

function resetYoutubeCaptionState() {
  youtubeLastCaption = "";
  youtubeCaptionMissingSince = 0;
  youtubeLastSeenAt = 0;
  youtubePendingCaption = "";
  if (youtubePendingTimer) {
    window.clearTimeout(youtubePendingTimer);
    youtubePendingTimer = null;
  }
  youtubeRequestId += 1;
  hideYoutubeOverlay();
}

function hideYoutubeOverlay() {
  const overlay = document.querySelector(".avision-youtube-caption-overlay");
  if (overlay) {
    overlay.textContent = "";
    overlay.classList.add("avision-youtube-caption-hidden");
    overlay.classList.remove("avision-youtube-caption-error");
  }
}

function clearStaleYoutubeOverlay() {
  if (!youtubeLastCaption) {
    return;
  }

  if (youtubeCaptionMissingSince) {
    if (Date.now() - youtubeCaptionMissingSince > YOUTUBE_LATE_RESULT_GRACE_MS) {
      resetYoutubeCaptionState();
    }
    return;
  }

  if (Date.now() - youtubeLastSeenAt > YOUTUBE_VISIBLE_STALE_MS) {
    resetYoutubeCaptionState();
  }
}

function ensureYoutubeOverlay() {
  let overlay = document.querySelector(".avision-youtube-caption-overlay");
  if (overlay) {
    return overlay;
  }

  const player = document.querySelector(".html5-video-player") || document.body;
  overlay = document.createElement("div");
  overlay.className = "avision-youtube-caption-overlay avision-youtube-caption-hidden";
  overlay.textContent = "";
  player.appendChild(overlay);
  return overlay;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function hasLetters(text) {
  return /[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text);
}

function stableHash(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
