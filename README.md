# LIMEN

An endless liminal-space horror game. Rooms, objects and creatures are generated at runtime by small in-browser neural networks. Built on three.js (WebGPU, with a WebGL2 fallback).

© 2026 TAM3R. All Rights Reserved. See [LICENSE](LICENSE).

## Run locally

```bash
npm install
```

```bash
npm run dev
```

Opens http://localhost:5173.

## Deploy to Cloudflare Workers

The game is a static site served by Workers Static Assets (no Worker script, so no per-request cost or cold start).

```bash
npx wrangler login
```

```bash
npm run deploy
```

Or connect the repo in the Cloudflare dashboard (Workers & Pages → Create → Import a repository) with:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

`npm run preview` builds and serves the game locally inside the real Workers runtime.

### What keeps it fast

- Vite bundles and minifies everything into two files (~310 KB gzipped instead of ~4 MB raw across 25 requests).
- three.js sits in its own chunk, so game updates don't make players re-download it.
- `public/_headers`: hashed files in `/assets/` are cached for a year; `index.html` is always revalidated so new builds show up immediately.
- Cloudflare compresses responses with Brotli automatically.
