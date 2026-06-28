# Avision Immersive Translator

Chrome MV3 extension for bilingual paragraph translation.

## Current MVP

- Uses the self-hosted LibreTranslate service at `https://translate.avision-gb10.org`.
- Translates readable page paragraphs and inserts the translation under the original text.
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
