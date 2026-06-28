# Avision Immersive Translator

Chrome MV3 extension for bilingual paragraph translation.

## Current MVP

- Uses the self-hosted LibreTranslate service at `https://translate.avision-gb10.org`.
- Can use a user-provided Google Apps Script Web App URL as a translation provider.
- Translates readable page paragraphs and inserts the translation under the original text.
- Translates selected page text in a small popup.
- Clears inserted page translations from the current page.
- Adds experimental YouTube caption translation with caption-track mode and live DOM fallback.
- Lets users choose YouTube caption mode: Auto, Caption track only, or Live visible captions only.
- Batches and locally caches YouTube caption-track translations with `chrome.storage.local`.
- Falls back to LibreTranslate when a selected provider such as Google Apps Script fails, if fallback is enabled.
- Saves settings in `chrome.storage.sync`.
- Keeps settings slots for Azure Translator, OpenAI, Google Cloud Translation, and DeepL for later provider adapters.

## Install Locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder.
5. Open an English page, click the extension, then click Translate Page.

## Notes

LibreTranslate currently exposes Traditional Chinese as `zh-Hant`, Simplified Chinese as `zh-Hans`, and Russian as `ru`. The MVP defaults to Traditional Chinese.

YouTube caption-track mode pretranslates an initial batch of captions and stores translated caption text locally. Replaying the same video and caption track should reuse cached translations.

## Google Apps Script Provider

Create a Google Apps Script Web App and paste this script:

```js
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || "{}");
    var q = body.q || "";
    var source = body.source || "";
    var target = body.target || "zh-TW";

    if (!q) {
      return json({ ok: false, error: "Missing q" });
    }

    var translatedText = LanguageApp.translate(q, source, target);
    return json({ ok: true, translatedText: translatedText });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Deploy it as a Web App, set access to anyone, copy the `/exec` URL, then paste it into Settings under Google Apps Script.

If the Google Apps Script quota is exhausted or the Web App returns an error, the extension can fall back to LibreTranslate when Settings > Fallback provider is set to LibreTranslate.
