# Design pins

Source of every file here: the design-system Artifact `https://claude.ai/artifact/QdEv9cVyqSfTPnWRQnrwVf`, version
`1795173666-f832` (read 2026-11-20). The files are pulled, never edited; the site build reads them (`site/lib/page.mjs`).
A new design version means a new pull, new sha256 values here, and a green `site/test/build.test.mjs`.

| File here | Artifact path (`project/eve-cyno/project/...`) | sha256 |
|---|---|---|
| `plugin-docs-2026-11-20.html` | `plugin-docs.html` | `c3aecaf137c0faf1782483f9a27b3f04d31903b9797e37392ed458f299d1ba4f` |
| `plugin-docs.css` | the `<style id="plugin-docs-css">` block of `plugin-docs.html`, verbatim | `a0cdb66d57024bdff39ec1a99b60a66389d8079218d42c9da5b3ad3994605838` |
| `site-base.css` | `site-base.css` | `53939473ac49268a305a54b62d9d73a1bfe04a37c6ae4dc18e7f799326bccb94` |
| `data-docs.css` | `data-docs.css` | `71368364066346630e1b274482b17233c8046e203fac3c611a5f7a22f52cfef5` |
| `data-site.js` | `data-site.js` | `31f18c5683b86f3a3a952b612e9a15f21bf8ad6c119f3ede31c57f6515faf728` |
| `favicon.svg` | `brand/favicon.svg` | `9e9a28d42b10e62bdd323bc676ae52d5af5b465944a5e71de4333eefe6e544b0` |
| `favicon-small.svg` | `brand/favicon-small.svg` | `d1c8e3fe5f03bab6dff42e89c52d35209ea4b56eb43a57c4fd87325e774b5c4e` |

Notes:

- `plugin-docs-2026-11-20.html` has one extra first line, a `source:` comment. The sha256 above is of the bytes below that
  line, which are the Artifact file byte for byte. The `<style data-demo>`, the page-state switcher and the demo board script
  are in the snapshot as designed; the build never uses them.
- `site-base.css` is in the Artifact (the design file's header says it is not; that note is wrong). Its sha256 equals the pin of
  `eve-cyno-web/docs/open_design_sync/artifact-pins.md` for `site-base.css` (`1794617686-adcc`). The design file carries a
  design-only stand-in (`<style data-demo id="site-base-standin">`) that is not ported.
- `brand/wordmark-motion.css` is not loaded by the plugin docs (the static `.pd-mark` is used), so it is not pinned here.
- The light theme (`prefers-color-scheme: light`, `[data-theme="light"]`) is part of `plugin-docs.css` as the design agent
  wrote it. The owner has not reviewed it yet.
- The page loads the web fonts Space Grotesk and JetBrains Mono from Google Fonts, as the design does.
