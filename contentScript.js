const TRANSLATION_CLASS = "avision-translator-translation";
const TRANSLATED_ATTR = "data-avision-translated";
const CACHE_PREFIX = "v1:";
const YOUTUBE_LATE_RESULT_GRACE_MS = 2500;
const YOUTUBE_POLL_MS = 250;
const YOUTUBE_STABLE_DELAY_MS = 220;
const YOUTUBE_VISIBLE_STALE_MS = 1400;

let pageVisible = true;
let youtubeCaptionObserver = null;
let youtubeLastCaption = "";
let youtubeCaptionMissingSince = 0;
let youtubeLastSeenAt = 0;
let youtubePendingCaption = "";
let youtubePendingTimer = null;
let youtubePollTimer = null;
let youtubeRequestId = 0;
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

  if (message?.type === "toggleTranslations") {
    pageVisible = !pageVisible;
    document.documentElement.classList.toggle("avision-translator-hidden", !pageVisible);
    return { ok: true, visible: pageVisible };
  }

  if (message?.type === "startYoutubeCaptions") {
    const summary = startYoutubeCaptionTranslation();
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
  const nodes = findTranslatableNodes();
  const maxCharacters = Number(settings.maxCharactersPerPage || 60000);
  let usedCharacters = 0;
  let translated = 0;
  let skipped = 0;
  let failed = 0;

  for (const node of nodes) {
    const text = normalizeText(node.innerText);
    if (!text || node.getAttribute(TRANSLATED_ATTR) === "true") {
      skipped += 1;
      continue;
    }

    if (usedCharacters + text.length > maxCharacters) {
      skipped += 1;
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
  }

  pageVisible = true;
  document.documentElement.classList.remove("avision-translator-hidden");
  return { translated, skipped, failed, characters: usedCharacters };
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

function findTranslatableNodes() {
  const selectors = [
    "main p",
    "article p",
    "section p",
    "p",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4"
  ];

  return Array.from(document.querySelectorAll(selectors.join(",")))
    .filter(isUsefulTextNode)
    .filter((node, index, list) => list.indexOf(node) === index);
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

function startYoutubeCaptionTranslation() {
  if (!location.hostname.includes("youtube.com")) {
    throw new Error("Open a YouTube video page before starting caption translation.");
  }

  ensureYoutubeOverlay();
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
  return { mode: "youtubeCaptions" };
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
