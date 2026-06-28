const translateButton = document.querySelector("#translatePage");
const youtubeButton = document.querySelector("#youtubeCaptions");
const toggleButton = document.querySelector("#toggleTranslations");
const optionsButton = document.querySelector("#openOptions");
const statusEl = document.querySelector("#status");
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

toggleButton.addEventListener("click", async () => {
  await sendToActiveTab({ type: "toggleTranslations" }, "Toggling...");
});

youtubeButton.addEventListener("click", async () => {
  await sendToActiveTab({ type: "startYoutubeCaptions" }, "Starting YouTube captions...");
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function sendToActiveTab(message, pendingText) {
  setBusy(true, pendingText);
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
      setStatus(`Translated ${translated}. Skipped ${skipped}. Failed ${failed}.`);
    } else if (message.type === "startYoutubeCaptions") {
      setStatus("YouTube caption translation is running. Turn on video captions.");
    } else {
      setStatus(response.visible ? "Translations visible." : "Translations hidden.");
    }
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    setBusy(false);
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
  youtubeButton.disabled = isBusy;
  toggleButton.disabled = isBusy;
  setStatus(text);
}

function setStatus(text) {
  statusEl.textContent = text;
}

function providerName(provider) {
  const labels = {
    libretranslate: "LibreTranslate",
    azure: "Azure Translator",
    openai: "OpenAI",
    google: "Google Cloud",
    deepl: "DeepL"
  };
  return labels[provider] || provider;
}
