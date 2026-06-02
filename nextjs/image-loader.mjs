/**
 * Next.js custom image loader for the masters-only media service.
 *
 * Lets <Image> request any width straight from the master via ?w= (so you can run
 * the "drop formats" mode — Strapi stores no responsive variants and the service
 * resizes on demand). Next.js generates the correct srcset widths automatically.
 *
 * next.config.js:
 *   module.exports = {
 *     images: { loader: 'custom', loaderFile: './nextjs/image-loader.mjs' },
 *   };
 *
 * Then use <Image src="https://images.rutba.pk/uploads/277/x.jpg" width={500} height={375} />
 * (or a relative src like "/uploads/277/x.jpg" — the base is taken from
 * NEXT_PUBLIC_IMAGE_URL). The loader emits ".../x.jpg?w=<width>&q=<quality>&fm=auto".
 */
export default function mediaLoader({ src, width, quality }) {
  const base = (process.env.NEXT_PUBLIC_IMAGE_URL || '').replace(/\/+$/, '');
  const abs = /^https?:\/\//i.test(src) ? src : `${base}${src.startsWith('/') ? '' : '/'}${src}`;
  let u;
  try { u = new URL(abs); } catch { return src; }
  u.searchParams.set('w', String(width));
  u.searchParams.set('q', String(quality || 80));
  if (!u.searchParams.has('fm')) u.searchParams.set('fm', 'auto'); // webp/avif when the browser supports it
  return u.toString();
}
