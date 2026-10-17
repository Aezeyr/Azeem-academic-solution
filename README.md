# Azeem Academic Hub

A free, static research article finder for qualitative and quantitative thesis research. The browser queries **OpenAlex**, **Crossref**, and **Semantic Scholar** directly; the site does not require an account or backend. The search supports separate From Year and To Year bounds.

## Source policy

- Search results are normalized only from provider responses.
- DOI links are rendered only when a provider supplies a DOI.
- Free-PDF links are rendered only when a provider supplies a PDF URL.
- No DOI, PDF, author, or publication metadata is fabricated.
- Open the original record and verify it before citing.

## Local preview

Serve this directory with any static server, for example:

```bash
python3 -m http.server 8788
```

Then open `http://localhost:8788/`.

## Cloudflare Workers Static Assets

`wrangler.toml` keeps deployment static-only and points Cloudflare at the repository root. The existing Cloudflare project/Workers settings should remain unchanged; the repository is intended to be auto-deployed from `main`.

## PWA

The site includes `manifest.webmanifest`, installable icons, a versioned service worker, an offline page, and a browser-controlled **Install app** button. The service worker caches only same-origin app-shell files and never intercepts the OpenAlex, Crossref, or Semantic Scholar API origins.
