const DEFAULT_SETTINGS = {
  provider: "libretranslate",
  sourceLanguage: "auto",
  targetLanguage: "zh-Hant",
  maxCharactersPerPage: 60000,
  youtubeMode: "auto",
  fallbackProvider: "libretranslate",
  appearance: {
    fontFamily: "Arial, sans-serif",
    pageFontSize: 16,
    youtubeFontSize: 24
  },
  libretranslate: {
    endpoint: "https://translate.avision-gb10.org",
    apiKey: ""
  },
  azure: {
    endpoint: "",
    region: "",
    apiKey: ""
  },
  openai: {
    apiKey: "",
    model: "gpt-4.1-mini"
  },
  google: {
    apiKey: ""
  },
  gas: {
    endpoint: ""
  },
  deepl: {
    endpoint: "https://api-free.deepl.com/v2/translate",
    apiKey: ""
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get("settings");
  if (!existing.settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function handleMessage(message) {
  if (message?.type === "getSettings") {
    return { ok: true, settings: await getSettings() };
  }

  if (message?.type === "saveSettings") {
    const settings = mergeSettings(DEFAULT_SETTINGS, message.settings || {});
    await chrome.storage.sync.set({ settings });
    return { ok: true, settings };
  }

  if (message?.type === "translateText") {
    const settings = await getSettings();
    const result = await translateText(message.text, settings);
    return { ok: true, result };
  }

  if (message?.type === "translateBatch") {
    const settings = await getSettings();
    const texts = Array.isArray(message.texts) ? message.texts : [];
    const results = await translateBatch(texts, settings);
    return { ok: true, results };
  }

  if (message?.type === "getCacheStats") {
    return { ok: true, stats: await getCacheStats() };
  }

  if (message?.type === "clearTranslationCache") {
    return { ok: true, summary: await clearTranslationCache(message.scope || "all") };
  }

  if (message?.type === "pageTranslationProgress") {
    return { ok: true };
  }

  throw new Error(`Unknown message type: ${message?.type}`);
}

async function getSettings() {
  const data = await chrome.storage.sync.get("settings");
  return mergeSettings(DEFAULT_SETTINGS, data.settings || {});
}

function mergeSettings(base, override) {
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key]) {
      output[key] = { ...output[key], ...value };
    } else {
      output[key] = value;
    }
  }
  return output;
}

async function getCacheStats() {
  const data = await chrome.storage.local.get(null);
  const keys = Object.keys(data);
  const youtubeKeys = keys.filter((key) => key.startsWith("yt:"));
  const allSize = estimateStorageSize(data, keys);
  const youtubeSize = estimateStorageSize(data, youtubeKeys);
  return {
    totalItems: keys.length,
    totalBytes: allSize,
    youtubeItems: youtubeKeys.length,
    youtubeBytes: youtubeSize
  };
}

async function clearTranslationCache(scope) {
  const data = await chrome.storage.local.get(null);
  const keys = Object.keys(data);
  const removeKeys = scope === "youtube"
    ? keys.filter((key) => key.startsWith("yt:"))
    : keys;
  if (removeKeys.length) {
    await chrome.storage.local.remove(removeKeys);
  }
  return {
    removed: removeKeys.length,
    scope
  };
}

function estimateStorageSize(data, keys) {
  return keys.reduce((total, key) => {
    return total + key.length + JSON.stringify(data[key] ?? "").length;
  }, 0);
}

async function translateText(text, settings) {
  const provider = settings.provider || "libretranslate";
  try {
    return await translateTextWithProvider(text, settings, provider);
  } catch (error) {
    const fallbackProvider = settings.fallbackProvider || "none";
    if (provider !== "libretranslate" && fallbackProvider === "libretranslate") {
      const result = await translateTextWithProvider(text, settings, "libretranslate");
      return {
        ...result,
        provider: `${provider}->${result.provider}`,
        fallbackReason: error.message || String(error)
      };
    }
    throw error;
  }
}

async function translateTextWithProvider(text, settings, provider) {
  if (provider === "libretranslate") {
    return translateWithLibreTranslate(text, settings);
  }
  if (provider === "gas") {
    return translateWithGoogleAppsScript(text, settings);
  }
  throw new Error(`${provider} provider is reserved but not implemented in this MVP.`);
}

async function translateBatch(texts, settings) {
  const merged = await tryTranslateMergedBatch(texts, settings);
  if (merged) {
    return merged;
  }

  const output = [];
  for (const text of texts) {
    output.push(await translateText(text, settings));
  }
  return output;
}

async function tryTranslateMergedBatch(texts, settings) {
  const cleanTexts = texts.map((text) => String(text || "").trim());
  if (cleanTexts.length < 2 || cleanTexts.some((text) => !text || text.length > 500)) {
    return null;
  }

  const separatorPrefix = "AVISION_SEGMENT_";
  const mergedText = cleanTexts
    .map((text, index) => `${separatorPrefix}${index}\n${text}`)
    .join(`\n${separatorPrefix}END\n`);

  if (mergedText.length > 4500) {
    return null;
  }

  try {
    const result = await translateText(mergedText, settings);
    const pieces = splitMergedBatchResult(result.translatedText, cleanTexts.length, separatorPrefix);
    if (!pieces) {
      return null;
    }

    return pieces.map((translatedText) => ({
      translatedText,
      provider: `${result.provider}-batch`
    }));
  } catch (error) {
    return null;
  }
}

function splitMergedBatchResult(text, expectedCount, separatorPrefix) {
  const normalized = String(text || "").replace(/\r/g, "");
  const pieces = [];

  for (let index = 0; index < expectedCount; index += 1) {
    const current = normalized.indexOf(`${separatorPrefix}${index}`);
    const next = index + 1 < expectedCount
      ? normalized.indexOf(`${separatorPrefix}${index + 1}`)
      : normalized.length;

    if (current < 0 || next < 0 || next <= current) {
      return null;
    }

    const raw = normalized.slice(current, next);
    const cleaned = raw
      .replace(`${separatorPrefix}${index}`, "")
      .replaceAll(`${separatorPrefix}END`, "")
      .trim();

    if (!cleaned) {
      return null;
    }
    pieces.push(cleaned);
  }

  return pieces.length === expectedCount ? pieces : null;
}

async function translateWithGoogleAppsScript(text, settings) {
  const endpoint = String(settings.gas?.endpoint || "").trim();
  if (!endpoint) {
    throw new Error("Google Apps Script Web App URL is not configured.");
  }

  const payload = {
    q: text,
    source: normalizeGasSource(settings.sourceLanguage),
    target: normalizeGasTarget(settings.targetLanguage)
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    return await parseGasResponse(response);
  } catch (postError) {
    const url = new URL(endpoint);
    url.searchParams.set("q", payload.q);
    url.searchParams.set("source", payload.source);
    url.searchParams.set("target", payload.target);
    const response = await fetch(url.toString(), { method: "GET" });
    return parseGasResponse(response);
  }
}

async function parseGasResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google Apps Script failed (${response.status}): ${text.slice(0, 300)}`);
  }

  try {
    const data = JSON.parse(text);
    if (data.ok === false) {
      throw new Error(data.error || "Google Apps Script returned an error.");
    }
    return {
      translatedText: data.translatedText || data.text || "",
      provider: "gas"
    };
  } catch (error) {
    if (text.trim().startsWith("{")) {
      throw error;
    }
    return {
      translatedText: text,
      provider: "gas"
    };
  }
}

function normalizeGasSource(language) {
  return !language || language === "auto" ? "" : normalizeGasTarget(language);
}

function normalizeGasTarget(language) {
  if (language === "zh-Hant" || language === "zh-TW" || language === "zh") {
    return "zh-TW";
  }
  if (language === "zh-Hans") {
    return "zh-CN";
  }
  return language || "zh-TW";
}

async function translateWithLibreTranslate(text, settings) {
  const endpoint = normalizeEndpoint(settings.libretranslate.endpoint);
  const target = normalizeLibreTarget(settings.targetLanguage);
  const requestTarget = target === "zh-Hant" ? "zh-Hans" : target;
  const primaryChunks = requestTarget === "zh-Hans"
    ? splitTextIntoSentences(text)
    : splitTextForTranslation(text);
  const primary = await translateLibreChunks(endpoint, primaryChunks, settings, requestTarget, target);
  let selected = primary;

  if (target === "zh-Hant" && text.length > 100) {
    const fallbackChunks = splitTextIntoClauses(text);
    if (fallbackChunks.length > primaryChunks.length) {
      const fallback = await translateLibreChunks(endpoint, fallbackChunks, settings, requestTarget, target);
      if (translationInfoScore(fallback.translatedText) > translationInfoScore(primary.translatedText) * 1.2) {
        selected = fallback;
      }
    }
  }

  return {
    translatedText: selected.translatedText,
    detectedSource: selected.detectedSource,
    provider: "libretranslate"
  };
}

async function translateLibreChunks(endpoint, chunks, settings, requestTarget, outputTarget) {
  const translatedChunks = [];
  let detectedSource;

  for (const chunk of chunks) {
    const prepared = prepareTextForTranslation(chunk);
    const data = await requestLibreTranslate(endpoint, prepared.text, settings, requestTarget);
    detectedSource ||= data.detectedLanguage?.language;
    translatedChunks.push(
      postProcessTranslation(
        restoreProtectedTerms(data.translatedText || "", prepared.protectedTerms),
        outputTarget
      )
    );
  }

  return {
    translatedText: joinTranslatedChunks(translatedChunks, outputTarget),
    detectedSource
  };
}

async function requestLibreTranslate(endpoint, text, settings, target) {
  const body = {
    q: text,
    source: settings.sourceLanguage || "auto",
    target,
    format: "text"
  };

  if (settings.libretranslate.apiKey) {
    body.api_key = settings.libretranslate.apiKey;
  }

  const response = await fetch(`${endpoint}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`LibreTranslate failed (${response.status}): ${details.slice(0, 300)}`);
  }

  return response.json();
}

function normalizeEndpoint(endpoint) {
  return String(endpoint || DEFAULT_SETTINGS.libretranslate.endpoint).replace(/\/+$/, "");
}

function normalizeLibreTarget(language) {
  if (language === "zh-TW" || language === "zh") {
    return "zh-Hant";
  }
  return language || "zh-Hant";
}

function splitTextForTranslation(text) {
  const normalized = String(text || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= 90) {
    return [normalized];
  }

  const sentences = normalized.match(/[^.!?。！？]+[.!?。！？]+["']?|[^.!?。！？]+$/g) || [normalized];
  const chunks = [];
  let current = "";

  for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
    if (!current) {
      current = sentence;
      continue;
    }

    if (`${current} ${sentence}`.length <= 90) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(...splitLongChunk(current));
      current = sentence;
    }
  }

  if (current) {
    chunks.push(...splitLongChunk(current));
  }

  return chunks;
}

function splitTextIntoSentences(text) {
  const normalized = normalizeSourceForTranslation(text);
  if (normalized.length <= 420) {
    return [normalized];
  }

  const sentences = normalized.match(/[^.!?。！？]+[.!?。！？]+["']?|[^.!?。！？]+$/g) || [normalized];
  const chunks = [];
  let current = "";
  for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
    if (!current || `${current} ${sentence}`.length <= 360) {
      current = current ? `${current} ${sentence}` : sentence;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function splitTextIntoClauses(text) {
  return splitLongChunk(normalizeSourceForTranslation(text));
}

function translationInfoScore(text) {
  return String(text || "").replace(/[^\w\u3400-\u9fff]/g, "").length;
}

function normalizeSourceForTranslation(text) {
  return String(text || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function splitLongChunk(text) {
  if (text.length <= 90) {
    return [text];
  }

  const pieces = text.split(/([,;:，；：])/);
  const chunks = [];

  for (let index = 0; index < pieces.length; index += 2) {
    const piece = `${pieces[index] || ""}${pieces[index + 1] || ""}`.trim();
    if (!piece) {
      continue;
    }
    chunks.push(...splitByWords(piece));
  }

  return chunks.length ? chunks : [text];
}

function splitByWords(text) {
  if (text.length <= 90) {
    return [text];
  }

  const chunks = [];
  let current = "";
  for (const word of text.split(" ").filter(Boolean)) {
    if (!current || `${current} ${word}`.length <= 80) {
      current = current ? `${current} ${word}` : word;
    } else {
      chunks.push(current);
      current = word;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function joinTranslatedChunks(chunks, targetLanguage) {
  const filtered = chunks.map((chunk) => chunk.trim()).filter(Boolean);
  if (targetLanguage === "zh-Hant" || targetLanguage === "zh-Hans") {
    return filtered.join("");
  }
  return filtered.join(" ");
}

function prepareTextForTranslation(text) {
  const protectedTerms = [];
  let output = text;
  const terms = [
    { pattern: /\bAvision Translator\b/g, replacement: "Avision Translator" },
    { pattern: /\bAvision\b/g, replacement: "Avision" },
    { pattern: /\bLibreTranslate\b/g, replacement: "LibreTranslate" },
    { pattern: /\bChrome Extension\b/g, replacement: "Chrome 擴充功能" },
    { pattern: /\bChrome\b/g, replacement: "Chrome" },
    { pattern: /\bextension\b/gi, replacement: "擴充功能" },
    { pattern: /\bAPI\b/g, replacement: "API" }
  ];

  for (const term of terms) {
    output = output.replace(term.pattern, (match) => {
      const token = `AVISIONTERM${protectedTerms.length}TOKEN`;
      protectedTerms.push({ token, replacement: term.replacement, original: match });
      return token;
    });
  }

  return { text: output, protectedTerms };
}

function restoreProtectedTerms(text, protectedTerms) {
  let output = text;
  for (const item of protectedTerms) {
    output = output.replace(new RegExp(escapeRegExp(item.token), "gi"), item.replacement);
  }
  return output;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function postProcessTranslation(text, targetLanguage) {
  if (targetLanguage !== "zh-Hant") {
    return text;
  }

  const replacements = [
    ["应", "應"],
    ["几", "幾"],
    ["气", "氣"],
    ["国", "國"],
    ["对", "對"],
    ["济", "濟"],
    ["乐", "樂"],
    ["观", "觀"],
    ["费", "費"],
    ["从", "從"],
    ["学", "學"],
    ["调", "調"],
    ["导", "導"],
    ["涨", "漲"],
    ["来", "來"],
    ["争", "爭"],
    ["们", "們"],
    ["资", "資"],
    ["级", "級"],
    ["诉", "訴"],
    ["讼", "訟"],
    ["关", "關"],
    ["满", "滿"],
    ["产", "產"],
    ["强", "強"],
    ["经", "經"],
    ["数", "數"],
    ["据", "據"],
    ["发", "發"],
    ["布", "布"],
    ["绪", "緒"],
    ["终", "終"],
    ["读", "讀"],
    ["查", "查"],
    ["显", "顯"],
    ["标", "標"],
    ["战", "戰"],
    ["于", "於"],
    ["为", "為"],
    ["汉", "漢"],
    ["体", "體"],
    ["测", "測"],
    ["试", "試"],
    ["检", "檢"],
    ["译", "譯"],
    ["区", "區"],
    ["块", "塊"],
    ["扩", "擴"],
    ["变", "變"],
    ["发", "發"],
    ["页", "頁"],
    ["这", "這"],
    ["个", "個"],
    ["会", "會"],
    ["后", "後"],
    ["与", "與"],
    ["服务", "服務"],
    ["文本", "文字"],
    ["征收", "徵收"],
    ["徵收關稅", "課徵關稅"],
    ["關税", "關稅"],
    ["税單", "關稅"],
    ["稅單", "關稅"],
    ["氣价", "汽油價格"],
    ["氣價", "汽油價格"],
    ["价格", "價格"],
    ["標志着", "標誌著"],
    ["星期五", "週五"],
    ["早期的", "先前的"],
    ["最後的", "最終的"],
    ["检测", "偵測"],
    ["检測", "偵測"],
    ["延伸區", "擴充功能"],
    ["延伸可以", "擴充功能可以"],
    ["發送至", "送到"],
    ["應直接放在", "應直接顯示在"],
    ["翻譯考驗", "翻譯測試"],
    ["試驗頁面", "測試頁面"],
    ["傳統中文", "繁體中文"]
  ];

  let output = text;
  for (const [from, to] of replacements) {
    output = output.replaceAll(from, to);
  }
  return output
    .replaceAll(",", "，")
    .replace(/(?<!\d)\.(?!\d)/g, "。")
    .replace(/(\d+(?:\.\d+)?)讀/g, "$1")
    .replace(/\s+([，。！？；：])/g, "$1")
    .replace(/([，。！？；：])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。！？；：])(?=[^\s\u3400-\u9fff])/g, "$1 ");
}
