const translateButton = document.querySelector("#translatePage");
const cancelButton = document.querySelector("#cancelTranslation");
const selectionButton = document.querySelector("#translateSelection");
const youtubeButton = document.querySelector("#youtubeCaptions");
const toggleButton = document.querySelector("#toggleTranslations");
const clearButton = document.querySelector("#clearTranslations");
const optionsButton = document.querySelector("#openOptions");
const statusEl = document.querySelector("#status");
const progressEl = document.querySelector("#progress");
const providerLabel = document.querySelector("#providerLabel");

init();

async function init() {
  const settings = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (settings?.ok) {
    providerLabel.textContent = providerName(settings.settings.provider);
  }
}

translateButton.addEventListener("click", async () => {
  await sendToActiveTab({ type: "translatePage" }, "Translating...");
});

cancelButton.addEventListener("click", async () => {
  await sendCancelToActiveTab();
});

selectionButton.addEventListener("click", async () => {
  await sendToActiveTab({ type: "translateSelection" }, "Translating selection...");
});

toggleButton.addEventListener("click", async () => {
  await sendToActiveTab({ type: "toggleTranslations" }, "Toggling...");
});

clearButton.addEventListener("click", async () => {
  await sendToActiveTab({ type: "clearTranslations" }, "Clearing...");
});

youtubeButton.addEventListener("click", async () => {
  await sendToActiveTab({ type: "startYoutubeCaptions" }, "Starting YouTube captions...");
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function sendToActiveTab(message, pendingText) {
  setBusy(true, pendingText);
  if (message.type === "translatePage") {
    showProgress(true, 0, 1);
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    assertSupportedTab(tab);
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response?.ok) {
      throw new Error(response?.error || "The page is not ready yet. Refresh and try again.");
    }

    if (message.type === "translatePage") {
      const { translated, skipped, failed } = response.summary;
      const reason = response.summary.reason ? ` ${response.summary.reason}` : "";
      const prefix = response.summary.cancelled ? "Cancelled." : "Done.";
      setStatus(`${prefix} Translated ${translated}. Skipped ${skipped}. Failed ${failed}.${reason}`);
    } else if (message.type === "translateSelection") {
      if (response.summary.translated) {
        setStatus(`Selection translated (${response.summary.characters} chars).`);
      } else {
        setStatus(response.summary.reason || "Selection was not translated.");
      }
    } else if (message.type === "clearTranslations") {
      setStatus(`Cleared ${response.summary.removed} translation item(s).`);
    } else if (message.type === "startYoutubeCaptions") {
      if (response.summary?.mode === "youtubeTrack") {
        setStatus(`YouTube track ready. Initial: ${response.summary.captions}/${response.summary.totalCaptions || response.summary.captions}.`);
      } else {
        const reason = response.summary?.fallbackReason ? ` ${response.summary.fallbackReason}` : "";
        setStatus(`YouTube live mode running.${reason}`);
      }
    } else {
      setStatus(response.visible ? "Translations visible." : "Translations hidden.");
    }
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    if (message.type === "translatePage") {
      showProgress(false);
    }
    setBusy(false);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "pageTranslationProgress") {
    return;
  }

  const summary = message.summary || {};
  const processed = Number(summary.processed || 0);
  const total = Math.max(1, Number(summary.total || 1));
  showProgress(true, processed, total);
  setStatus(`Translating ${processed}/${total}. Done ${summary.translated || 0}, skipped ${summary.skipped || 0}, failed ${summary.failed || 0}.`);
});

async function sendCancelToActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: "cancelPageTranslation" });
    setStatus("Cancelling after the current paragraph...");
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (response?.ok) {
      return;
    }
  } catch (error) {
    const message = error.message || String(error);
    if (!message.includes("Receiving end does not exist")) {
      throw error;
    }
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["styles/injected.css"]
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["contentScript.js"]
  });
}

function assertSupportedTab(tab) {
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const url = tab.url || "";
  const unsupportedPrefixes = ["chrome://", "chrome-extension://", "edge://", "about:"];
  if (unsupportedPrefixes.some((prefix) => url.startsWith(prefix))) {
    throw new Error("Chrome internal pages cannot be translated. Open a normal web page and try again.");
  }

  if (url.startsWith("https://chromewebstore.google.com/")) {
    throw new Error("Chrome Web Store pages block extension scripts. Try a normal article page.");
  }
}

function setBusy(isBusy, text = "") {
  translateButton.disabled = isBusy;
  cancelButton.classList.toggle("hidden", !isBusy);
  cancelButton.disabled = !isBusy;
  selectionButton.disabled = isBusy;
  youtubeButton.disabled = isBusy;
  toggleButton.disabled = isBusy;
  clearButton.disabled = isBusy;
  setStatus(text);
}

function showProgress(show, value = 0, max = 1) {
  progressEl.classList.toggle("hidden", !show);
  progressEl.max = max;
  progressEl.value = value;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function providerName(provider) {
  const labels = {
    libretranslate: "LibreTranslate",
    gas: "Google Apps Script",
    azure: "Azure Translator",
    openai: "OpenAI",
    google: "Google Cloud",
    deepl: "DeepL"
  };
  return labels[provider] || provider;
}
