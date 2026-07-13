'use strict';

/**
 * Normalize `sharp` image metadata (+ decoded EXIF) into a flat record for the
 * `file_metadata` table. Degrades gracefully: `exif-reader` is optional (like sharp
 * itself), EXIF parsing is wrapped in try/catch, and a raster with no EXIF still
 * yields format/dimensions. Callers pass the object `sharp(path).metadata()` already
 * returned, so this module never touches disk.
 *
 * Promoted columns (camera, lens, taken_at, ISO/exposure/aperture/focal length, GPS)
 * cover the common "photo metadata" surface; the full parsed structure is kept in
 * `raw` for anything else.
 */

let exifReader = null;
try { exifReader = require('exif-reader'); } catch { /* optional */ }

// Convert an EXIF GPS coordinate ([deg,min,sec] + ref) to signed decimal degrees.
function gpsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const [d, m, s] = dms.map(Number);
  if ([d, m, s].some((n) => Number.isNaN(n))) return null;
  let dec = d + m / 60 + s / 3600;
  if (ref === 'S' || ref === 'W') dec = -dec;
  return Math.round(dec * 1e7) / 1e7;
}

function toMysqlDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Build the file_metadata record from a sharp metadata object. Returns null if the
// input isn't usable (non-image).
function normalizeMetadata(m) {
  if (!m || (!m.width && !m.format)) return null;
  const out = {
    format: m.format || null,
    color_space: m.space || null,
    width: m.width || null,
    height: m.height || null,
    has_alpha: m.hasAlpha ? 1 : 0,
    orientation: m.orientation || null,
    density: m.density || null,
    camera_make: null, camera_model: null, lens: null, taken_at: null,
    iso: null, exposure: null, f_number: null, focal_length: null,
    gps_lat: null, gps_lng: null, raw: null,
  };

  if (m.exif && exifReader) {
    try {
      const ex = exifReader(m.exif);
      // Support both exif-reader v2 (Image/Photo/GPSInfo) and v1 (image/exif/gps).
      const img = ex.Image || ex.image || {};
      const photo = ex.Photo || ex.exif || {};
      const gps = ex.GPSInfo || ex.gps || {};
      out.camera_make = str(img.Make);
      out.camera_model = str(img.Model);
      out.lens = str(photo.LensModel);
      out.taken_at = toMysqlDate(photo.DateTimeOriginal || photo.DateTimeDigitized || img.DateTime);
      out.iso = num(photo.ISOSpeedRatings || photo.PhotographicSensitivity || photo.ISO);
      if (photo.ExposureTime != null) out.exposure = fmtExposure(photo.ExposureTime);
      out.f_number = num(photo.FNumber);
      out.focal_length = num(photo.FocalLength);
      const lat = gpsToDecimal(gps.GPSLatitude, gps.GPSLatitudeRef);
      const lng = gpsToDecimal(gps.GPSLongitude, gps.GPSLongitudeRef);
      if (lat != null) out.gps_lat = lat;
      if (lng != null) out.gps_lng = lng;
      out.raw = safeJson({ image: img, photo, gps });
    } catch { /* unparseable EXIF — keep the decoded fields only */ }
  }
  return out;
}

function str(v) { return v == null ? null : String(v).replace(/\0/g, '').trim().slice(0, 128) || null; }
function num(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function fmtExposure(t) { const n = Number(t); if (!Number.isFinite(n) || n <= 0) return null; return n >= 1 ? `${n}s` : `1/${Math.round(1 / n)}s`; }
function safeJson(o) { try { return JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? Number(v) : v)); } catch { return null; } }

// Build a file_metadata record from an ffprobe result (video/audio). Duration,
// codecs, bitrate and fps have no dedicated columns, so they live in `raw`; width/
// height/format are promoted.
function normalizeProbe(p) {
  if (!p) return null;
  return {
    format: p.videoCodec || p.audioCodec || null,
    color_space: null, width: p.width || null, height: p.height || null,
    has_alpha: 0, orientation: null, density: null,
    camera_make: null, camera_model: null, lens: null, taken_at: null,
    iso: null, exposure: null, f_number: null, focal_length: null,
    gps_lat: null, gps_lng: null,
    raw: safeJson({ durationSec: p.durationSec, videoCodec: p.videoCodec, audioCodec: p.audioCodec, bitRate: p.bitRate, fps: p.fps }),
  };
}

module.exports = { normalizeMetadata, normalizeProbe, gpsToDecimal };
