# Changelog

## 2026-06-28

### Added

- Added a popup fallback that injects the content script and CSS when the current tab was opened before the extension loaded.
- Added clearer popup errors for unsupported browser pages such as Chrome internal pages and the Chrome Web Store.
- Added a local basic test page at `test-pages/basic.html`.
- Added LibreTranslate source-term protection for names and technical terms such as `Avision Translator`, `Chrome`, `LibreTranslate`, `API`, and `extension`.
- Added Traditional Chinese cleanup for common Simplified Chinese leftovers, translation terminology, and Chinese punctuation.
- Added chunked LibreTranslate requests so long paragraphs and quoted news/legal text are translated in smaller pieces instead of being truncated by the backend model.
- Added a Traditional Chinese bridge that uses LibreTranslate's Simplified Chinese model for better completeness, then applies local Traditional Chinese cleanup.
- Added dual-candidate selection for long Chinese translations, comparing full-sentence and clause-split results to avoid overly short translated output.
- Added experimental YouTube caption translation mode that watches visible YouTube caption text and overlays translated captions on the video player.
- Fixed YouTube caption overlay cleanup so stale translated captions are hidden when YouTube captions disappear or older translation requests finish late.
- Tuned YouTube caption timing with a short late-result grace window, faster polling, and stale-result guards so slower translations can still appear briefly without overwriting newer captions.
- Debounced YouTube caption updates and removed the visible `Translating...` placeholder so rapidly changing captions do not keep the overlay stuck in a loading state.
- Updated YouTube caption overlay behavior to keep the previous completed translation visible until the next translation result is ready or the caption grace window expires.
- Added experimental YouTube caption track mode that reads `ytInitialPlayerResponse` caption tracks, fetches `json3` timed captions, pretranslates an initial batch, and displays translations by video time.
- Added fallback from YouTube caption track mode to live DOM caption mode when no usable track is found or the timed text request fails.
- Added a user-selectable YouTube caption mode setting: Auto, Caption track only, or Live visible captions only.
- Added popup controls for translating selected page text and clearing inserted page translations.
- Improved page translation status messages for empty pages, already translated pages, selected-text errors, and clear counts.
- Added Google Apps Script as a selectable translation provider with a user-configurable Web App URL.
- Added YouTube caption-track batch translation and persistent local caption cache using `chrome.storage.local`.
- Added merged batch translation in the background provider router, with fallback to per-segment translation if a provider does not preserve segment markers.
- Added provider fallback setting. When enabled, failed non-LibreTranslate providers fall back to LibreTranslate.
- Created the Chrome MV3 extension MVP.
- Added popup controls for translating the current page and toggling translations.
- Added content script support for scanning readable paragraphs, headings, list items, and blockquotes.
- Added bilingual translation rendering under the original text.
- Added LibreTranslate provider support using `https://translate.avision-gb10.org`.
- Added settings page for provider, source language, target language, max characters per page, and LibreTranslate endpoint/API key.
- Reserved settings fields for Azure Translator, OpenAI, Google Cloud Translation, and DeepL.
- Added Traditional Chinese (`zh-Hant`) and Russian (`ru`) to target language options.
- Added local README with installation and MVP notes.

### Changed

- Moved the project to `D:\projects\chrome_translate`.
- Changed the default target language from Simplified Chinese (`zh-Hans`) to Traditional Chinese (`zh-Hant`).
- Updated LibreTranslate language normalization so `zh` and `zh-TW` map to `zh-Hant`.

### Verified

- Confirmed `https://translate.avision-gb10.org/languages` returns available languages.
- Confirmed LibreTranslate can translate English to Traditional Chinese.
- Confirmed LibreTranslate can translate English to Russian.
- Ran syntax checks for `background.js`, `contentScript.js`, `popup/popup.js`, and `options/options.js`.
- Confirmed `manifest.json` parses successfully.

### GitHub

- Created private GitHub repository: `brianshih04/chrome_translate`.

### Known Limitations

- Only LibreTranslate is implemented as a working provider in the MVP.
- LibreTranslate may still produce weak wording for legal, political, or news text; OpenAI, DeepL, or Azure should be added for higher-quality translation.
- Azure Translator, OpenAI, Google Cloud Translation, and DeepL are reserved but not wired yet.
- Selected-text translation is not implemented yet.
- Hover-to-translate single paragraph mode is not implemented yet.
- YouTube caption translation requires YouTube captions to be enabled on the video and currently stops only when the page is refreshed.
- Translation cache is currently in-memory only for the active page session.
