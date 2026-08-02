# Colour in Photo

Turn a local photo into a private, playable colour-by-numbers canvas. Image
decoding, segmentation, palette extraction, gameplay, and PNG export all happen
inside the browser; the selected photo is never uploaded.

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The default build is a static, installable web app intended for Netlify:

```bash
npm run build
```

It writes the complete site to `out/`. In the `lyndons-website` repository, set
Netlify's **Base directory** to `apps/colour-in-photo` and leave the Package
directory unset. The nested `netlify.toml` supplies the build command, publish
directory, Node version, and caching headers. The optional Sites build remains
available as `npm run build:sites`.

On iPad, open the deployed site in Safari and choose **Share → Add to Home
Screen** to install it like an app. Photos continue to be processed only in the
browser and are never uploaded.

## Validation

```bash
npm run lint
npm test
```

The app uses a Web Worker for deterministic puzzle generation and Canvas 2D for
rendering, Pencil/touch input, and flat-colour export.
