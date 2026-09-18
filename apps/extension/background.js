/**
 * The whole extension: clicking the toolbar icon injects the SAME bundle the
 * bookmarklet carries (takeout.js) into the current tab. No content scripts, no
 * host permissions, nothing runs until the click — `activeTab` grants access to
 * just that tab, just then.
 *
 * world: "MAIN" — the bundle must run as page script (it patches fetch/XHR to
 * observe how the app authenticates, and calls the API with the page's own
 * cookies), exactly as a bookmarklet does. Unlike a bookmarklet, this injection
 * isn't subject to the page's CSP.
 *
 * allFrames — wrapper portals iframe MyChart from another origin; the bundle
 * itself decides which single frame speaks up (frameRole in main.ts). Frames
 * the click doesn't grant access to are skipped by Chrome; if the all-frames
 * call is refused outright, fall back to the top frame.
 */
async function inject(tabId) {
  const base = { world: "MAIN", files: ["takeout.js"] };
  try {
    await chrome.scripting.executeScript({ ...base, target: { tabId, allFrames: true } });
  } catch {
    await chrome.scripting.executeScript({ ...base, target: { tabId } });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  try {
    await inject(tab.id);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  } catch (e) {
    // chrome:// pages, the Web Store, PDFs… — nowhere to show an overlay.
    console.warn("MyChart Takeout: can't run on this page:", e);
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#b91c1c" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setTitle({ tabId: tab.id, title: "MyChart Takeout can't run on this page — open your MyChart portal first." });
  }
});

// Test hook (the e2e suite can't click a toolbar icon).
self.__inject = inject;
