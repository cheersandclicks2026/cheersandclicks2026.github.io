/**
 * CheersAndClicks 2026 — photo upload endpoint (Google Apps Script web app).
 *
 * Deploy: Deploy → New deployment → type "Web app"
 *         Execute as: Me        Who has access: Anyone
 * Then copy the /exec URL into config.js (UPLOAD_URL).
 *
 * After the event: Deploy → Manage deployments → Archive  (stops all uploads).
 */

const FOLDER_ID  = 'PASTE_DRIVE_FOLDER_ID_HERE';   // from the Drive folder URL: drive.google.com/drive/folders/<THIS PART>
const EVENT_CODE = 'cheers2026';                    // must match config.js
const MAX_BYTES  = 35 * 1024 * 1024;                // 35 MB per photo (full-resolution friendly)
const ALLOWED_MIME = /^image\/(jpeg|png|heic|heif|webp)$/;

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return out({ ok: false, error: 'empty request' });

    const d = JSON.parse(e.postData.contents);
    if (d.code !== EVENT_CODE) return out({ ok: false, error: 'bad code' });
    if (typeof d.image !== 'string' || !d.image) return out({ ok: false, error: 'no image' });

    // Cheap size check before decoding (base64 is ~4/3 of the real size).
    if (d.image.length * 0.75 > MAX_BYTES) return out({ ok: false, error: 'too large' });

    const name = String(d.fileName || 'photo.jpg').replace(/[^\w.\-]/g, '_').slice(0, 120);
    const mime = ALLOWED_MIME.test(d.mimeType) ? d.mimeType : 'image/jpeg';
    const folder = DriveApp.getFolderById(FOLDER_ID);

    // Idempotent: if a retry arrives for a photo that was already saved, don't create a duplicate.
    if (folder.getFilesByName(name).hasNext()) return out({ ok: true, duplicate: true });

    const bytes = Utilities.base64Decode(d.image);
    if (bytes.length > MAX_BYTES) return out({ ok: false, error: 'too large' });

    folder.createFile(Utilities.newBlob(bytes, mime, name));
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// Open the /exec URL in a browser to check the deployment is live.
function doGet() {
  return out({ ok: true, service: 'CheersAndClicks 2026 upload endpoint' });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
