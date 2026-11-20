/* Cheers & Clicks 2026 — camera → capture → upload to Google Drive (via Apps Script) */
(() => {
  'use strict';

  const CFG = window.CC_CONFIG || {};
  const MAX_ATTEMPTS = 5;
  const FIRST_RETRY_MS = 2000;
  const REQUEST_TIMEOUT_MS = 120000;
  const FATAL_ERRORS = ['bad code', 'too large', 'no image', 'empty request'];
  const TRANSIENT_ERROR = /too many|simultaneous|unavailable|server error|timed? ?out|try again|rate|quota|exceeded|busy/i;
  const MAX_BATCH = 20;
  const MAX_FILE_BYTES = 35 * 1024 * 1024; // must match MAX_BYTES in apps-script/Code.gs
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp' };

  const $ = (id) => document.getElementById(id);
  const el = {
    screens: document.querySelectorAll('.screen'),
    video: $('video'), countdown: $('countdown'), flash: $('flash'), hint: $('cameraHint'),
    startBtn: $('startBtn'), welcomeNativeBtn: $('welcomeNativeBtn'), welcomeGalleryBtn: $('welcomeGalleryBtn'),
    galleryBtn: $('galleryBtn'), galleryInput: $('galleryInput'), photoGrid: $('photoGrid'), doneTitle: $('doneTitle'), moreBtn: $('moreBtn'),
    shutterBtn: $('shutterBtn'), timerBtn: $('timerBtn'), timerLabel: $('timerLabel'), flipBtn: $('flipBtn'), nativeBtn: $('nativeBtn'), nativeInput: $('nativeInput'),
    previewImg: $('previewImg'), photoMeta: $('photoMeta'),
    sendingOverlay: $('sendingOverlay'), sendingText: $('sendingText'),
    doneOverlay: $('doneOverlay'), burst: $('burst'),
    status: $('status'), actionsReview: $('actionsReview'), actionsDone: $('actionsDone'),
    retakeBtn: $('retakeBtn'), sendBtn: $('sendBtn'), saveBtn: $('saveBtn'),
    anotherBtn: $('anotherBtn'), saveDoneBtn: $('saveDoneBtn'),
    errorTitle: $('error-title'), errorText: $('errorText'), errorSteps: $('errorSteps'),
    errorNativeBtn: $('errorNativeBtn'), errorRetryBtn: $('errorRetryBtn'), errorGalleryBtn: $('errorGalleryBtn'),
  };

  const state = {
    stream: null,
    facing: 'environment',     // back camera by default
    busy: false,               // countdown / capture in progress
    timer: true,               // 3-2-1 countdown on/off (remembered per device)
    uploading: false,
    photos: [],                // [{ blob, mime, name, url, base64, status, tile }]
    lastSource: 'camera',      // 'camera' | 'native' | 'gallery'
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
  const isConfigured = () => typeof CFG.UPLOAD_URL === 'string' && /^https:\/\//.test(CFG.UPLOAD_URL) && !CFG.UPLOAD_URL.includes('PASTE');

  /* ---------------- UI helpers ---------------- */
  function show(name) {
    el.screens.forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
  }
  function setStatus(text, kind) {
    el.status.textContent = text || '';
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }
  function formatMB(bytes) { return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + ' MB'; }

  function makeBubbles() {
    const box = $('bubbles');
    if (!box || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (let i = 0; i < 18; i++) {
      const b = document.createElement('span');
      const size = 5 + Math.random() * 14;
      const dur = 9 + Math.random() * 10;
      b.className = 'bubble';
      b.style.cssText = `left:${Math.random() * 100}%;width:${size}px;height:${size}px;animation-duration:${dur}s;animation-delay:${-Math.random() * dur}s`;
      box.appendChild(b);
    }
  }

  function makeBurst() {
    el.burst.innerHTML = '';
    const n = 16;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i');
      p.style.setProperty('--a', `${(360 / n) * i}deg`);
      p.style.setProperty('--d', `${-(70 + Math.random() * 50)}px`);
      p.style.animationDelay = `${0.45 + Math.random() * 0.15}s`;
      el.burst.appendChild(p);
    }
  }

  /* ---------------- Camera ---------------- */
  function stopStream() {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }

  function liveTrack() {
    const t = state.stream && state.stream.getVideoTracks()[0];
    return t && t.readyState === 'live' ? t : null;
  }

  async function startCamera() {
    if (!window.isSecureContext) return showCameraError({ name: 'InsecureContext' });
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return showCameraError({ name: 'Unsupported' });

    const label = el.startBtn.lastChild;
    el.startBtn.disabled = true;
    const oldText = label.textContent;
    label.textContent = ' Opening camera…';

    try {
      stopStream();
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // Ask for the biggest frame the camera allows; the browser picks the closest it supports.
        video: { facingMode: { ideal: state.facing }, width: { ideal: 4096 }, height: { ideal: 3072 } },
      });
      el.video.srcObject = state.stream;
      el.video.classList.toggle('mirror', state.facing === 'user');
      await el.video.play().catch(() => {});
      el.hint.style.opacity = '1';
      show('camera');
      updateFlipButton();
    } catch (err) {
      showCameraError(err);
    } finally {
      el.startBtn.disabled = false;
      label.textContent = oldText;
    }
  }

  async function updateFlipButton() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === 'videoinput');
      el.flipBtn.classList.toggle('invisible', cams.length < 2);
    } catch { /* keep visible */ }
  }

  function showCameraError(err) {
    const name = (err && err.name) || 'Error';
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
    let title = 'Camera unavailable';
    let text = "We couldn't open your camera. You can still take a photo with your phone's camera app.";
    let steps = [];

    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      title = 'Camera permission needed';
      text = 'Camera access was blocked. To allow it:';
      steps = isIOS
        ? ['Tap the <b>aA</b> (or ⋯) icon in the address bar.', 'Choose <b>Website Settings</b> → <b>Camera</b> → <b>Allow</b>.', 'Come back and tap <b>Try again</b>.']
        : ['Tap the <b>lock / settings</b> icon next to the address.', 'Open <b>Permissions</b> → <b>Camera</b> → <b>Allow</b>.', 'Come back and tap <b>Try again</b>.'];
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      text = 'Your camera seems to be in use by another app. Close it and tap Try again.';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
      text = "We couldn't find a camera on this device.";
    } else if (name === 'Unsupported' || name === 'InsecureContext') {
      text = "This browser can't open the camera inside the page (QR scanner apps sometimes do this). Open the link in Safari or Chrome, or use your camera app below.";
    }

    el.errorTitle.textContent = title;
    el.errorText.textContent = text;
    el.errorSteps.innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
    el.errorSteps.hidden = steps.length === 0;
    show('error');
  }

  async function capture() {
    const track = liveTrack();
    if (state.busy) return;
    if (!track) return startCamera();
    state.busy = true;
    el.shutterBtn.disabled = true;
    el.flipBtn.disabled = true;
    el.timerBtn.disabled = true;
    el.nativeBtn.disabled = true;
    el.galleryBtn.disabled = true;
    el.hint.style.opacity = '0';

    try {
      for (const n of state.timer ? [3, 2, 1] : []) {
        el.countdown.innerHTML = `<span>${n}</span>`;
        await sleep(1000);
      }
      el.countdown.innerHTML = '';
      el.flash.classList.remove('go');
      void el.flash.offsetWidth; // restart animation
      el.flash.classList.add('go');

      const shot = await takePhoto(track);
      el.video.pause();
      setPhotos([{ blob: shot.blob, mime: shot.mime }], 'camera');
    } catch (err) {
      console.error(err);
      el.hint.textContent = 'Oops — try that again ✦';
      el.hint.style.opacity = '1';
    } finally {
      el.countdown.innerHTML = '';
      state.busy = false;
      el.shutterBtn.disabled = false;
      el.flipBtn.disabled = false;
      el.timerBtn.disabled = false;
      el.nativeBtn.disabled = false;
      el.galleryBtn.disabled = false;
    }
  }

  async function takePhoto(track) {
    // 1) Chrome / Android: real still photo at the sensor's full resolution.
    if ('ImageCapture' in window) {
      try {
        const ic = new window.ImageCapture(track);
        let opts = {};
        try {
          const caps = await ic.getPhotoCapabilities();
          if (caps && caps.imageWidth && caps.imageWidth.max) {
            opts = { imageWidth: caps.imageWidth.max, imageHeight: caps.imageHeight.max };
          }
        } catch { /* capabilities not available */ }
        let blob;
        try { blob = await ic.takePhoto(opts); } catch { blob = await ic.takePhoto(); }
        if (blob && blob.size > 0) return { blob, mime: blob.type || 'image/jpeg' };
      } catch (e) {
        console.warn('ImageCapture failed, falling back to video frame', e);
      }
    }

    // 2) iPhone Safari & others: grab the live frame at its native size, high-quality JPEG.
    const v = el.video;
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) throw new Error('Camera not ready');
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(v, 0, 0, w, h); // not mirrored: saved photo looks like reality
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Encode failed'))), 'image/jpeg', 0.95));
    return { blob, mime: 'image/jpeg' };
  }

  /* ---------------- Native camera app & photo library ---------------- */
  function openNative() { el.nativeInput.click(); }
  function openGallery() { el.galleryInput.click(); }

  function mimeOf(file) {
    if (file.type) return file.type;
    const ext = (file.name.split('.').pop() || '').toLowerCase().replace('jpeg', 'jpg');
    return Object.keys(EXT).find((m) => EXT[m] === ext) || 'image/jpeg';
  }

  el.nativeInput.addEventListener('change', () => {
    const file = el.nativeInput.files && el.nativeInput.files[0];
    el.nativeInput.value = '';
    if (!file) return;
    if (state.stream) el.video.pause();
    setPhotos([{ blob: file, mime: mimeOf(file) }], 'native');
  });

  el.galleryInput.addEventListener('change', () => {
    const files = Array.from(el.galleryInput.files || []).filter((f) => !f.type || f.type.startsWith('image/'));
    el.galleryInput.value = '';
    if (!files.length) return;
    if (state.stream) el.video.pause();
    setPhotos(files.slice(0, MAX_BATCH).map((f) => ({ blob: f, mime: mimeOf(f) })), 'gallery');
    if (files.length > MAX_BATCH) {
      setStatus(`You picked ${files.length} — we'll send the first ${MAX_BATCH}. Tap “Upload more” after for the rest.`);
    }
  });

  /* ---------------- Preview ---------------- */
  function makeFileName(mime) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `${CFG.FILE_PREFIX || 'CheersAndClicks2026'}_${stamp}_${rand}.${EXT[mime] || 'jpg'}`;
  }

  function setTile(photo, status) {
    photo.status = status;
    if (photo.tile) photo.tile.dataset.status = status;
  }

  // items: [{ blob, mime }], source: 'camera' | 'native' | 'gallery'
  function setPhotos(items, source) {
    clearPhotos();
    state.lastSource = source;
    state.photos = items.map(({ blob, mime }) => ({
      blob, mime, name: makeFileName(mime), url: URL.createObjectURL(blob), base64: null, status: 'pending', tile: null,
    }));
    const n = state.photos.length;
    const multi = n > 1;
    const fromGallery = source === 'gallery';

    el.previewImg.hidden = multi;
    el.photoMeta.hidden = multi;
    el.photoGrid.hidden = !multi;
    el.photoGrid.innerHTML = '';

    if (multi) {
      state.photos.forEach((p, i) => {
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.dataset.status = 'pending';
        tile.dataset.ext = (EXT[p.mime] || 'photo').toUpperCase();
        const img = document.createElement('img');
        img.alt = `Photo ${i + 1}`;
        img.decoding = 'async';
        img.onerror = () => tile.classList.add('no-thumb'); // e.g. HEIC on some browsers
        img.src = p.url;
        const badge = document.createElement('span');
        badge.className = 'tile-badge';
        tile.append(img, badge);
        p.tile = tile;
        el.photoGrid.appendChild(tile);
      });
    } else {
      const p = state.photos[0];
      el.photoMeta.textContent = formatMB(p.blob.size);
      el.previewImg.onload = () => {
        const { naturalWidth: w, naturalHeight: h } = el.previewImg;
        if (w && h) el.photoMeta.textContent = `${w} × ${h} · ${(w * h / 1e6).toFixed(1)} MP · ${formatMB(p.blob.size)}`;
      };
      el.previewImg.src = p.url;
    }

    el.doneTitle.textContent = multi ? `${n} photos added!` : 'Added to the album!';
    el.sendingOverlay.classList.remove('show');
    el.doneOverlay.classList.remove('show');
    el.actionsReview.hidden = false;
    el.actionsDone.hidden = true;
    el.saveBtn.hidden = fromGallery;          // already on their phone
    el.saveDoneBtn.hidden = fromGallery;
    el.moreBtn.hidden = !fromGallery;
    el.retakeBtn.lastChild.textContent = source === 'camera' ? ' Retake' : ' Choose again';
    el.anotherBtn.lastChild.textContent = fromGallery ? ' Take a photo' : ' Take another';
    el.sendBtn.disabled = false;
    el.retakeBtn.disabled = false;
    el.sendBtn.lastChild.textContent = multi ? ` Send ${n} photos` : ' Send to album';
    setStatus(!isConfigured() ? '' : multi ? `${n} photos ready — send them to the album.` : 'Looking good? Send it to the album.');
    show('preview');
  }

  function clearPhotos() {
    state.photos.forEach((p) => URL.revokeObjectURL(p.url));
    state.photos = [];
  }

  function goCamera() {
    el.hint.textContent = 'Strike a pose ✦';
    if (liveTrack()) {
      el.video.play().catch(() => {});
      el.hint.style.opacity = '1';
      show('camera');
    } else {
      startCamera();
    }
  }

  // "Retake" / "Choose again": repeat whatever the guest did last.
  function retake() {
    if (state.uploading) return;
    if (state.lastSource === 'gallery') return openGallery();
    if (state.lastSource === 'native' || !navigator.mediaDevices) return openNative();
    goCamera();
  }

  // "Take another" / "Take a photo" after a successful send.
  function another() {
    if (state.uploading) return;
    if (liveTrack() || state.lastSource === 'camera') return goCamera();
    if (state.lastSource === 'native') return openNative();
    show('welcome');
  }

  /* ---------------- Upload ---------------- */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function postOnce(body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      // text/plain = "simple" CORS request → no preflight (Apps Script can't answer OPTIONS).
      const res = await fetch(CFG.UPLOAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'follow',
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`); // transient → retry
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        // Got a page instead of JSON — usually the deployment isn't set to "Anyone" or the URL is wrong.
        const err = new Error('unexpected reply from the upload service (check the Apps Script deployment is set to "Anyone")');
        err.name = 'BadReply';
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Upload one photo with retries. say(text) shows progress. Returns { ok, fatal }.
  async function uploadOne(photo, say) {
    if (photo.blob.size > MAX_FILE_BYTES) return { ok: false, fatal: 'too large' };
    if (!photo.base64) photo.base64 = await blobToBase64(photo.blob);
    const body = JSON.stringify({ fileName: photo.name, mimeType: photo.mime, image: photo.base64, code: CFG.EVENT_CODE });

    let delay = FIRST_RETRY_MS;
    let lastBadReply = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let reason = 'Connection problem';
      try {
        const data = await postOnce(body);
        if (data && data.ok) { photo.base64 = null; return { ok: true }; }
        const msg = (data && data.error) || 'unknown error';
        // Only retry errors that can fix themselves (busy / quota / timeout). Setup errors fail fast.
        if (FATAL_ERRORS.includes(msg) || !TRANSIENT_ERROR.test(msg)) return { ok: false, fatal: msg };
        reason = 'Upload service busy';
        console.warn(`Upload attempt ${attempt}: server said "${msg}"`);
      } catch (e) {
        // An HTML page instead of JSON: when overloaded, Google answers with an HTML error page
        // ("too many scripts running simultaneously"), so this is retried too. If it never
        // clears up, the message about the deployment setting is shown at the end.
        if (e && e.name === 'BadReply') { lastBadReply = e.message; reason = 'Upload service busy'; }
        console.warn(`Upload attempt ${attempt} failed`, e);
      }
      if (attempt < MAX_ATTEMPTS) {
        // Random jitter so a crowd that failed together doesn't retry at the same instant.
        let left = Math.round(delay * (0.6 + Math.random() * 0.8));
        while (left > 0) {
          say(`${reason} — retrying in ${Math.ceil(left / 1000)}s (try ${attempt + 1} of ${MAX_ATTEMPTS})…`);
          const step = left % 1000 || 1000;
          await sleep(step);
          left -= step;
        }
        delay *= 2;
      }
    }
    return { ok: false, fatal: lastBadReply };
  }

  async function sendPhotos() {
    const todo = state.photos.filter((p) => p.status !== 'done');
    if (!todo.length || state.uploading) return;
    if (!isConfigured()) {
      setStatus('Uploads aren’t set up yet — add UPLOAD_URL in config.js (see SETUP.md).', 'error');
      return;
    }

    const total = state.photos.length;
    const multi = total > 1;
    state.uploading = true;
    el.sendBtn.disabled = true;
    el.retakeBtn.disabled = true;
    setStatus('');
    if (!multi) el.sendingOverlay.classList.add('show');

    let fatal = '';
    for (const p of todo) {
      const idx = state.photos.indexOf(p) + 1;
      const say = multi ? (t) => setStatus(`Photo ${idx} of ${total}: ${t}`) : (t) => { el.sendingText.textContent = t; };
      say(multi ? 'sending…' : `Sending… (${formatMB(p.blob.size)})`);
      setTile(p, 'sending');
      let r;
      try { r = await uploadOne(p, say); } catch (e) { console.error(e); r = { ok: false, fatal: '' }; }
      if (r.ok) { setTile(p, 'done'); continue; }
      setTile(p, 'failed');
      fatal = r.fatal;
      if (r.fatal !== 'too large') break; // connection/setup problem — the rest would fail too
    }

    state.uploading = false;
    el.sendingOverlay.classList.remove('show');
    const done = state.photos.filter((p) => p.status === 'done').length;

    if (done === total) {
      makeBurst();
      el.doneOverlay.classList.add('show');
      el.actionsReview.hidden = true;
      el.actionsDone.hidden = false;
      el.saveBtn.hidden = true;
      setStatus('');
      return;
    }

    const left = state.photos.filter((p) => p.status !== 'done');
    const allTooBig = left.every((p) => p.blob.size > MAX_FILE_BYTES);
    el.sendBtn.disabled = allTooBig;
    el.retakeBtn.disabled = false;
    el.sendBtn.lastChild.textContent = multi ? ` Send remaining ${left.length}` : ' Try again';
    const why = fatal === 'too large' ? (multi ? 'Some photos are too large (max 35 MB each).' : 'This photo is too large to upload (max 35 MB).')
      : fatal === 'bad code' ? 'Upload rejected (event code mismatch).'
      : fatal ? `Upload failed: ${fatal}.`
      : 'Couldn’t send. Check your connection and try again.';
    const prefix = multi && done ? `${done} of ${total} sent. ` : '';
    const tail = state.lastSource === 'gallery' ? '' : ' You can still save it to your phone.';
    setStatus(prefix + why + tail, 'error');
  }

  /* ---------------- Save to phone ---------------- */
  async function savePhoto() {
    const photo = state.photos[0];
    if (!photo) return;
    const file = new File([photo.blob], photo.name, { type: photo.mime });

    if (isTouch() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Cheers & Clicks 2026' });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = photo.url;
    a.download = photo.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (isTouch() && !state.uploading) setStatus('If nothing downloaded, long-press the photo and choose “Save”.');
  }

  /* ---------------- Wire up ---------------- */
  el.startBtn.addEventListener('click', startCamera);
  el.welcomeNativeBtn.addEventListener('click', openNative);
  el.nativeBtn.addEventListener('click', openNative);
  el.errorNativeBtn.addEventListener('click', openNative);
  el.errorRetryBtn.addEventListener('click', startCamera);
  el.shutterBtn.addEventListener('click', capture);
  el.timerBtn.addEventListener('click', () => {
    if (state.busy) return;
    setTimer(!state.timer);
    try { localStorage.setItem('cc-timer', state.timer ? 'on' : 'off'); } catch { /* storage blocked */ }
  });
  el.flipBtn.addEventListener('click', () => {
    if (state.busy) return;
    state.facing = state.facing === 'environment' ? 'user' : 'environment';
    startCamera();
  });
  el.welcomeGalleryBtn.addEventListener('click', openGallery);
  el.galleryBtn.addEventListener('click', openGallery);
  el.errorGalleryBtn.addEventListener('click', openGallery);
  el.moreBtn.addEventListener('click', openGallery);
  el.retakeBtn.addEventListener('click', retake);
  el.anotherBtn.addEventListener('click', another);
  el.sendBtn.addEventListener('click', sendPhotos);
  el.saveBtn.addEventListener('click', savePhoto);
  el.saveDoneBtn.addEventListener('click', savePhoto);

  // Phones may kill the camera when the tab is backgrounded — revive it on return.
  document.addEventListener('visibilitychange', () => {
    const onCamera = document.querySelector('.screen.active')?.dataset.screen === 'camera';
    if (document.visibilityState === 'visible' && onCamera && !liveTrack()) startCamera();
  });

  // Warn before leaving mid-upload.
  window.addEventListener('beforeunload', (e) => {
    if (state.uploading) { e.preventDefault(); e.returnValue = ''; }
  });

  function setTimer(on) {
    state.timer = on;
    el.timerBtn.classList.toggle('on', on);
    el.timerBtn.setAttribute('aria-checked', String(on));
    el.timerLabel.textContent = on ? '3s' : 'Off';
    el.shutterBtn.setAttribute('aria-label', on ? 'Take photo (3 second countdown)' : 'Take photo now');
  }
  try { if (localStorage.getItem('cc-timer') === 'off') setTimer(false); } catch { /* storage blocked */ }

  makeBubbles();
})();
