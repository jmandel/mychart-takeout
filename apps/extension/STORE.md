# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste. Build the upload
with `bun run build:web` → `dist/extension.zip`; screenshots with
`bun tools/mock-mychart/src/store-screenshots.ts` → `dist/store/*.png`.

## Store listing

- **Name** (from manifest): MyChart Takeout
- **Summary** (from manifest `description`)
- **Category**: Tools (fallback: Health & Fitness)
- **Language**: English
- **Description**:

  > Export all of your own health data from an Epic MyChart patient portal — test results, visit notes, medications, messages and attachments, documents, and more — as a ZIP of readable reports plus the raw data.
  >
  > How to use it: sign in to your MyChart portal, click the MyChart Takeout toolbar button, then click "Export everything" (or scan first and choose what to include). When it finishes, download the ZIP.
  >
  > Private by design: it runs entirely in your browser tab, using the session you're already signed in with. There is no server and no account, and nothing is uploaded anywhere. It does nothing until you click its button, and asks for access only to the tab you click it on.
  >
  > It also works on health-system portals that embed MyChart inside their own site.
  >
  > Open source: https://github.com/jmandel/mychart-takeout
  >
  > MyChart Takeout is an independent open-source tool and is not affiliated with or endorsed by Epic Systems. "MyChart" and "Epic" are trademarks of Epic Systems Corporation.

- **Store icon**: `apps/extension/icons/icon128.png`
- **Screenshots** (1280×800): `dist/store/1-ready.png`, `2-choose.png`, `3-done.png`
- **Homepage URL**: https://joshuamandel.com/mychart-takeout/
- **Support URL**: https://github.com/jmandel/mychart-takeout/issues

## Privacy practices

- **Single purpose**: Lets a patient export their own health record from the Epic MyChart patient portal they are signed in to, as a ZIP file saved to their computer.
- **activeTab justification**: The extension acts only when the user clicks its toolbar button, and only on that tab: it starts the exporter in the MyChart page the user is looking at. No access to any site is requested in advance.
- **scripting justification**: Used once per click to inject the exporter script (bundled in the package as takeout.js) into the active tab, so it can read the user's record through the portal's own API with the user's existing session and build the ZIP in the page.
- **Host permissions**: none requested.
- **Remote code**: No. All code ships in the package; nothing is fetched or eval'd.
- **Data usage**: check **nothing** as collected. The extension handles health information locally in the tab in order to write the user's export file, but transmits nothing to the developer or any third party. Certify all three limited-use statements.
- **Privacy policy URL**: https://joshuamandel.com/mychart-takeout/privacy.html

## Distribution

- **Visibility**: Unlisted to start (install by link); switch to Public once a few portals are confirmed.
- **Regions**: all. **Pricing**: free.

## Releasing an update

Bump `version` in `apps/extension/manifest.json`, rebuild, upload the new zip
in the dashboard (Package → Upload new package), submit for review.
