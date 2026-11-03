# Third-party notices

## Tab Session Manager

Copyright (c) Sienori. Licensed under the Mozilla Public License 2.0
(see `LICENSE-MPL-2.0.txt`). Source: https://github.com/sienori/Tab-Session-Manager

The following files are derived from Tab Session Manager and remain under the MPL-2.0:

- `popup/popup.css` (ported from `src/popup/styles/*.scss`)
- `options/options.css` (ported from `src/options/styles/*.scss`)
- `_locales/*/messages.json` (UI strings shared with Tab Session Manager)
- `icons/icon.svg`, `icons/icon*.png`, `icons/logo.svg` (the floppy shape of the original icon, recolored: teal → white, white → transparent; the logo places it on a slate background)

The UI icon set in `popup/icons.js` is an original design and is not derived from Tab Session Manager.

The popup and options page layouts (`popup/popup.html`, `popup/popup.js`,
`options/options.html`, `options/options.js`) reimplement Tab Session Manager's
React components in plain JavaScript.
