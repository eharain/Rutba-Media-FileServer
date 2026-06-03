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

module.exports = { MIME, RASTER, FMT_EXT, MASTER_EXTS };
