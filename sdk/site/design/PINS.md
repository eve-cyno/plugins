# Design pins

Source of every file here: the EVE-Cyno design system (the project's design Artifact), version `1795190238-d942` (read
2026-11-20). The files are pulled, never edited (the cuts are noted below); the site build reads them (`site/lib/page.mjs`).
A new design version means a new pull, new sha256 values here, and a green `site/test/build.test.mjs`.

| File here | Artifact path (`project/eve-cyno/project/...`) | sha256 |
|---|---|---|
| `plugin-docs-2026-11-20.html` | `plugin-docs.html` | `1e4626cdb67f16315806c56740296a9ae1768dcb91a2345fc438954d0ff5499f` |
| `plugin-docs.css` | the `<style id="plugin-docs-css">` block of `plugin-docs.html`, verbatim | `a0cdb66d57024bdff39ec1a99b60a66389d8079218d42c9da5b3ad3994605838` |
| `site-base.css` | `site-base.css` | `53939473ac49268a305a54b62d9d73a1bfe04a37c6ae4dc18e7f799326bccb94` |
| `data-docs.css` | `data-docs.css` | `71368364066346630e1b274482b17233c8046e203fac3c611a5f7a22f52cfef5` |
| `data-site.js` | `data-site.js` | `31f18c5683b86f3a3a952b612e9a15f21bf8ad6c119f3ede31c57f6515faf728` |
| `favicon.svg` | `brand/favicon.svg` | `9e9a28d42b10e62bdd323bc676ae52d5af5b465944a5e71de4333eefe6e544b0` |
| `favicon-small.svg` | `brand/favicon-small.svg` | `d1c8e3fe5f03bab6dff42e89c52d35209ea4b56eb43a57c4fd87325e774b5c4e` |

Notes:

- `plugin-docs-2026-11-20.html` has one extra first line, a `source:` comment, and two cuts in the design's header comment: an internal
  work-item name (after `Derived from data-docs.html (2026-11-20`) and a reference to the plan (after `host open`). The sha256 in the table is of the
  Artifact file; the bytes below line 1 here have sha256 `8f08547ca782cf1f841ec9fc5ec04260a02e003f24cb956ed67b0c7af48fcaf9`,
  and the test checks that one. Nothing else differs, and no built page carries that comment. The `<style data-demo>`, the
  page-state switcher and the demo board script are in the snapshot as designed; the build never uses them.
- `site-base.css` is in the Artifact (the design file's header says it is not; that note is wrong). Its sha256 equals the design system's own pin of
  `site-base.css`. The design file carries a
  design-only stand-in (`<style data-demo id="site-base-standin">`) that is not ported.
- `brand/wordmark-motion.css` is not loaded by the plugin docs (the static `.pd-mark` is used), so it is not pinned here.
- The light theme (`prefers-color-scheme: light`, `[data-theme="light"]`) is part of `plugin-docs.css` as the design agent
  wrote it. The owner has not reviewed it yet.
- The design snapshot has no Google Fonts link any more; the build writes its own head (`site/lib/page.mjs`), and the fonts are self-hosted
  from `site/assets/fonts/` (pinned in `FONTS.md` there). A test checks the snapshot for any font-host reference.
