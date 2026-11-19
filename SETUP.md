# Cheers & Clicks 2026: setup guide

A QR code opens a camera page. Guests take a photo, and it's saved automatically to a Google Drive folder. After the event, you copy the photos to SharePoint.

```
QR code ─► GitHub Pages site (this folder) ─► Google Apps Script ─► Google Drive folder
```

Setup takes about 20 minutes. It's done in this order: Drive folder → Apps Script → config.js → GitHub Pages → QR code → test.

---

## 1. Create the Google Drive folder
1. Go to <https://drive.google.com> using your personal Gmail.
2. Click **New → New folder** and name it, for example, `CheersAndClicks 2026 Photos`.
3. Open the folder and copy the ID from the address bar:
   `https://drive.google.com/drive/folders/`**`1AbCdEf...xyz`** ← this part.
4. Check your free storage (bottom left in Drive). Each photo is roughly 0.5–5 MB.

## 2. Create the upload endpoint (Google Apps Script)
1. Go to <https://script.google.com> → **New project**, and rename it `CheersAndClicks Upload`.
2. Delete the sample code and paste the full contents of [apps-script/Code.gs](apps-script/Code.gs).
3. Set `FOLDER_ID` to the ID from step 1 (the full folder link also works). If you want your own `EVENT_CODE`, change it here and in `config.js`, keeping both the same.
4. Click **Save**.
5. Click **Deploy → New deployment** → the gear icon → **Web app**, then set:
   - Description: `v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click **Deploy**, then **Authorize access**. Choose your account; when you see "Google hasn't verified this app", click **Advanced → Go to CheersAndClicks Upload (unsafe)** → **Allow**. This warning is normal for your own scripts.
7. Copy the **Web app URL**. It ends in `/exec`.
8. Paste that URL into a browser. You should see `{"ok":true,"service":"CheersAndClicks 2026 upload endpoint"}`.

> If you edit `Code.gs` later, go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. This keeps the same URL.

## 3. Connect the page
Open [config.js](config.js) and paste the `/exec` URL into `UPLOAD_URL`.

## 4. Publish on GitHub Pages
1. On <https://github.com/new>, create a **public** repository, for example `cheersandclicks`, with no README.
2. In this folder, run:
   ```
   git remote add origin https://github.com/<your-username>/cheersandclicks.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
4. After about 1 minute your site is live at `https://<your-username>.github.io/cheersandclicks/`.

## 5. Make the QR code
```
cd qr
npm install
node make-qr.mjs https://<your-username>.github.io/cheersandclicks/
```
This creates `qr/cheersandclicks-qr.png` (2000 px, for print) and `qr/cheersandclicks-qr.svg` (vector, any size). Print it at least **4 × 4 cm**; 8 cm or larger is better for tables and posters. Test-scan the printout from about 1 m away.

## 6. Test before the event
- [ ] Open the site on **iPhone (Safari)** and **Android (Chrome)**: the permission prompt, back camera, Flip, 3-2-1 countdown and preview all work.
- [ ] **Send to album**: the photo appears in the Drive folder within a few seconds.
- [ ] **Max quality** (phone camera app) works, and that photo arrives as well.
- [ ] **Save to my phone** opens the share sheet or downloads the photo.
- [ ] Look at the resolution label on the preview (for example `4032 × 3024 · 12.2 MP · 3.8 MB`) to see the real quality from each phone.
- [ ] **Load test**: have about 10 people send at the same moment, and check that all the photos arrive. If the endpoint is busy, the page retries automatically.
- [ ] Turn on airplane mode and press Send. The page should show an error and let you **Try again** or save the photo.

## 7. After the event
1. **Stop uploads**: Apps Script → **Deploy → Manage deployments → Archive**. The URL stops working right away.
2. In Drive, right-click the folder → **Download** (it arrives as a zip).
3. Unzip it and upload the photos to your SharePoint folder by drag and drop.

---

> **Whenever you change `config.js`, `app.js` or `styles.css`:** bump `?v=2` → `?v=3` (etc.) on the matching lines at the bottom/top of `index.html`, so phones load the new file instead of a cached copy.

### Good to know
- **Quality:** on Android/Chrome, photos are true full-resolution stills. On iPhone, the in-page camera captures the video frame (usually around 1080p to 4K). For the full-quality iPhone photo, guests tap **Max quality**, which opens the iPhone Camera app.
- **Many people at once:** Apps Script handles up to **30 uploads at the same moment** per Google account. Beyond that, the page waits and retries (2 s, 4 s, 8 s, 16 s). Every file has a unique name, and retries never create duplicates. In practice, the venue's Wi-Fi upload speed is the real limit.
- **Security:** anyone who looks at the page source can see the upload URL and the event code. That's fine for one event: the code blocks random requests, uploads are capped at 35 MB, and you archive the deployment afterwards. The SharePoint link's expiry has no effect on this setup.
- **In-app QR scanners:** some scanner apps open links in a built-in browser that can't use the camera. The page detects this and offers the camera-app option. Most phones' built-in camera apps open the link in Safari or Chrome, which works fine.
