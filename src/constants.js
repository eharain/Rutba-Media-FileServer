'use strict';

/**
 * Static media tables: extension → MIME type, the set of raster formats `sharp`
 * can resize, and requested-format → output extension.
 */

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.pdf': 'application/pdf',
};

// Raster formats we resize. Everything else (video, svg, audio, pdf…) streams as-is.
const RASTER = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tiff', '.tif', '.gif']);

// Candidate master extensions (most-common first) tried when a variant's requested
// extension doesn't exist on disk — e.g. /small_x.webp resolves to master x.jpg.
const MASTER_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tiff', '.tif'];

// Requested output format → file extension for the cached variant.
const FMT_EXT = { jpeg: '.jpg', jpg: '.jpg', png: '.png', webp: '.webp', avif: '.avif' };

// Cluster / visibility wire protocol (all HTTP header names are lower-case, matching
// Node's req.headers). A master's visibility is recorded next to it in a small
// sidecar file (`<master>.vis` containing "public"/"private") when set explicitly.
const HDR_VISIBILITY = 'x-visibility';           // public | private (upload + replication)
const HDR_CLUSTER_SECRET = 'x-cluster-secret';   // node-to-node auth (CLUSTER_SECRET)
const HDR_CLUSTER_REPLICATED = 'x-cluster-replicated'; // "1" on a replicated write — receiver must NOT re-fan-out
// Fallback upload-auth header. Some front-ends (LiteSpeed/Apache/Passenger, e.g.
// Hostinger) strip the standard `Authorization` header before it reaches the app,
// which would 401 every write regardless of token. Accept the raw UPLOAD_TOKEN in
// this custom header too — custom `X-` headers are passed through untouched.
const HDR_UPLOAD_TOKEN = 'x-upload-token';        // = UPLOAD_TOKEN (Authorization-strip fallback)
const SIDECAR_EXT = '.vis';                       // visibility sidecar suffix (kept internal, never served)

module.exports = { MIME, RASTER, FMT_EXT, MASTER_EXTS, HDR_VISIBILITY, HDR_CLUSTER_SECRET, HDR_CLUSTER_REPLICATED, HDR_UPLOAD_TOKEN, SIDECAR_EXT };
