/* Cheers & Clicks 2026 — camera → capture → upload to Google Drive (via Apps Script) */
(() => {
  'use strict';

  const CFG = window.CC_CONFIG || {};
  const MAX_ATTEMPTS = 5;
  const FIRST_RETRY_MS = 2000;
  const REQUEST_TIMEOUT_MS = 120000;
  const FATAL_ERRORS = ['bad code', 'too large', 'no image', 'empty request'];
  const TRANSIENT_ERROR = /too many|simultaneous|unavailable|server error|timed? ?out|try again|rate|quota|exceeded|busy/i;
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp' };

  const $ = (id) => document.getElementById(id);
  const el = {
    screens: document.querySelectorAll('.screen'),
    video: $('video'), countdown: $('countdown'), flash: $('flash'), hint: $('cameraHint'),
    startBtn: $('startBtn'), welcomeNativeBtn: $('welcomeNativeBtn'),
    shutterBtn: $('shutterBtn'), timerBtn: $('timerBtn'), timerLabel: $('timerLabel'), flipBtn: $('flipBtn'), nativeBtn: $('nativeBtn'), nativeInput: $('nativeInput'),
    previewImg: $('previewImg'), photoMeta: $('photoMeta'),
    sendingOverlay: $('sendingOverlay'), sendingText: $('sendingText'),
    doneOverlay: $('doneOverlay'), burst: $('burst'),
    status: $('status'), actionsReview: $('actionsReview'), actionsDone: $('actionsDone'),
    retakeBtn: $('retakeBtn'), sendBtn: $('sendBtn'), saveBtn: $('saveBtn'),
    anotherBtn: $('anotherBtn'), saveDoneBtn: $('saveDoneBtn'),
    errorTitle: $('error-title'), errorText: $('errorText'), errorSteps: $('errorSteps'),
    errorNativeBtn: $('errorNativeBtn'), errorRetryBtn: $('errorRetryBtn'),
  };

  const state = {
    stream: null,
    facing: 'environment',     // back camera by default
    busy: false,               // countdown / capture in progress
    timer: true,               // 3-2-1 countdown on/off (remembered per device)
    uploading: false,
    sent: false,
    photo: null,               // { blob, mime, name, url, base64 }
    lastSource: 'camera',      // 'camera' | 'native'
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
      state.lastSource = 'camera';
      setPhoto(shot.blob, shot.mime);
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

  /* ---------------- Native camera app (full-resolution original) ---------------- */
  function openNative() { el.nativeInput.click(); }

  el.nativeInput.addEventListener('change', () => {
    const file = el.nativeInput.files && el.nativeInput.files[0];
    el.nativeInput.value = '';
    if (!file) return;
    let mime = file.type;
    if (!mime) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      mime = Object.keys(EXT).find((m) => EXT[m] === ext || (ext === 'jpeg' && m === 'image/jpeg')) || 'image/jpeg';
    }
    if (state.stream) el.video.pause();
    state.lastSource = 'native';
    setPhoto(file, mime);
  });

  /* ---------------- Preview ---------------- */
  function makeFileName(mime) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `${CFG.FILE_PREFIX || 'CheersAndClicks2026'}_${stamp}_${rand}.${EXT[mime] || 'jpg'}`;
  }

  function setPhoto(blob, mime) {
    clearPhoto();
    const url = URL.createObjectURL(blob);
    state.photo = { blob, mime, name: makeFileName(mime), url, base64: null };
    state.sent = false;

    el.photoMeta.textContent = formatMB(blob.size);
    el.previewImg.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = el.previewImg;
      if (w && h) el.photoMeta.textContent = `${w} × ${h} · ${(w * h / 1e6).toFixed(1)} MP · ${formatMB(blob.size)}`;
    };
    el.previewImg.src = url;

    el.sendingOverlay.classList.remove('show');
    el.doneOverlay.classList.remove('show');
    el.actionsReview.hidden = false;
    el.actionsDone.hidden = true;
    el.saveBtn.hidden = false;
    el.sendBtn.disabled = false;
    el.retakeBtn.disabled = false;
    el.sendBtn.lastChild.textContent = ' Send to album';
    setStatus(isConfigured() ? 'Looking good? Send it to the album.' : '');
    show('preview');
  }

  function clearPhoto() {
    if (state.photo && state.photo.url) URL.revokeObjectURL(state.photo.url);
    state.photo = null;
  }

  function backToCamera() {
    if (state.uploading) return;
    el.hint.textContent = 'Strike a pose ✦';
    if (liveTrack()) {
      el.video.play().catch(() => {});
      el.hint.style.opacity = '1';
      show('camera');
    } else if (state.lastSource === 'native' || !navigator.mediaDevices) {
      openNative();
    } else {
      startCamera();
    }
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

  async function sendPhoto() {
    const photo = state.photo;
    if (!photo || state.uploading || state.sent) return;
    if (!isConfigured()) {
      setStatus('Uploads aren’t set up yet — add UPLOAD_URL in config.js (see SETUP.md).', 'error');
      return;
    }

    state.uploading = true;
    el.sendBtn.disabled = true;
    el.retakeBtn.disabled = true;
    setStatus('');
    el.sendingText.textContent = `Sending… (${formatMB(photo.blob.size)})`;
    el.sendingOverlay.classList.add('show');

    let ok = false;
    let fatal = '';
    try {
      if (!photo.base64) photo.base64 = await blobToBase64(photo.blob);
      const body = JSON.stringify({ fileName: photo.name, mimeType: photo.mime, image: photo.base64, code: CFG.EVENT_CODE });

      let delay = FIRST_RETRY_MS;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let reason = 'Connection problem';
        try {
          const data = await postOnce(body);
          if (data && data.ok) { ok = true; break; }
          const msg = (data && data.error) || 'unknown error';
          // Only retry errors that can fix themselves (busy / quota / timeout). Setup errors fail fast.
          if (FATAL_ERRORS.includes(msg) || !TRANSIENT_ERROR.test(msg)) { fatal = msg; break; }
          reason = 'Upload service busy';
          console.warn(`Upload attempt ${attempt}: server said "${msg}"`);
        } catch (e) {
          if (e && e.name === 'BadReply') { fatal = e.message; break; }
          console.warn(`Upload attempt ${attempt} failed`, e);
        }
        if (attempt < MAX_ATTEMPTS) {
          for (let s = Math.round(delay / 1000); s > 0; s--) {
            el.sendingText.textContent = `${reason} — retrying in ${s}s (try ${attempt + 1} of ${MAX_ATTEMPTS})…`;
            await sleep(1000);
          }
          el.sendingText.textContent = `Sending… (try ${attempt + 1} of ${MAX_ATTEMPTS})`;
          delay *= 2;
        }
      }
    } catch (e) {
      console.error(e);
    }

    state.uploading = false;
    el.sendingOverlay.classList.remove('show');

    if (ok) {
      state.sent = true;
      makeBurst();
      el.doneOverlay.classList.add('show');
      el.actionsReview.hidden = true;
      el.actionsDone.hidden = false;
      el.saveBtn.hidden = true;
      setStatus('');
    } else {
      el.sendBtn.disabled = false;
      el.retakeBtn.disabled = false;
      el.sendBtn.lastChild.textContent = ' Try again';
      const why = fatal === 'too large' ? 'This photo is too large to upload.'
        : fatal === 'bad code' ? 'Upload rejected (event code mismatch).'
        : fatal ? `Upload failed: ${fatal}.`
        : 'Couldn’t send your photo. Check your connection and try again.';
      setStatus(why + ' You can still save it to your phone.', 'error');
    }
  }

  /* ---------------- Save to phone ---------------- */
  async function savePhoto() {
    const photo = state.photo;
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
  el.retakeBtn.addEventListener('click', backToCamera);
  el.anotherBtn.addEventListener('click', backToCamera);
  el.sendBtn.addEventListener('click', sendPhoto);
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
