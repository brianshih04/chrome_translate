const form = document.querySelector("#settingsForm");
const statusEl = document.querySelector("#status");

const fields = {
  provider: document.querySelector("#provider"),
  sourceLanguage: document.querySelector("#sourceLanguage"),
  targetLanguage: document.querySelector("#targetLanguage"),
  maxCharactersPerPage: document.querySelector("#maxCharactersPerPage"),
  youtubeMode: document.querySelector("#youtubeMode"),
  fallbackProvider: document.querySelector("#fallbackProvider"),
  libreEndpoint: document.querySelector("#libreEndpoint"),
  libreApiKey: document.querySelector("#libreApiKey"),
  gasEndpoint: document.querySelector("#gasEndpoint"),
  azureEndpoint: document.querySelector("#azureEndpoint"),
  azureRegion: document.querySelector("#azureRegion"),
  azureApiKey: document.querySelector("#azureApiKey"),
  openaiModel: document.querySelector("#openaiModel"),
  openaiApiKey: document.querySelector("#openaiApiKey"),
  googleApiKey: document.querySelector("#googleApiKey"),
  deeplEndpoint: document.querySelector("#deeplEndpoint"),
  deeplApiKey: document.querySelector("#deeplApiKey")
};

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = readSettings();
  const response = await chrome.runtime.sendMessage({ type: "saveSettings", settings });
  if (!response?.ok) {
    setStatus(response?.error || "Could not save settings.");
    return;
  }
  setStatus("Settings saved.");
});

async function loadSettings() {
  const response = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (!response?.ok) {
    setStatus(response?.error || "Could not load settings.");
    return;
  }

  const settings = response.settings;
  fields.provider.value = settings.provider;
  fields.sourceLanguage.value = settings.sourceLanguage;
  fields.targetLanguage.value = settings.targetLanguage;
  fields.maxCharactersPerPage.value = settings.maxCharactersPerPage;
  fields.youtubeMode.value = settings.youtubeMode || "auto";
  fields.fallbackProvider.value = settings.fallbackProvider || "libretranslate";
  fields.libreEndpoint.value = settings.libretranslate.endpoint;
  fields.libreApiKey.value = settings.libretranslate.apiKey;
  fields.gasEndpoint.value = settings.gas?.endpoint || "";
  fields.azureEndpoint.value = settings.azure.endpoint;
  fields.azureRegion.value = settings.azure.region;
  fields.azureApiKey.value = settings.azure.apiKey;
  fields.openaiModel.value = settings.openai.model;
  fields.openaiApiKey.value = settings.openai.apiKey;
  fields.googleApiKey.value = settings.google.apiKey;
  fields.deeplEndpoint.value = settings.deepl.endpoint;
  fields.deeplApiKey.value = settings.deepl.apiKey;
}

function readSettings() {
  return {
    provider: fields.provider.value,
    sourceLanguage: fields.sourceLanguage.value || "auto",
    targetLanguage: fields.targetLanguage.value,
    maxCharactersPerPage: Number(fields.maxCharactersPerPage.value || 60000),
    youtubeMode: fields.youtubeMode.value,
    fallbackProvider: fields.fallbackProvider.value,
    libretranslate: {
      endpoint: fields.libreEndpoint.value,
      apiKey: fields.libreApiKey.value
    },
    gas: {
      endpoint: fields.gasEndpoint.value
    },
    azure: {
      endpoint: fields.azureEndpoint.value,
      region: fields.azureRegion.value,
      apiKey: fields.azureApiKey.value
    },
    openai: {
      model: fields.openaiModel.value,
      apiKey: fields.openaiApiKey.value
    },
    google: {
      apiKey: fields.googleApiKey.value
    },
    deepl: {
      endpoint: fields.deeplEndpoint.value,
      apiKey: fields.deeplApiKey.value
    }
  };
}

function setStatus(text) {
  statusEl.textContent = text;
}
