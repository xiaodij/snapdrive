// One camera stream for the whole app session.
//
// iOS home-screen apps do not keep camera permission: WebKit asks again after the app is
// relaunched, whenever getUserMedia is called again after the stream was stopped, and after
// the URL fragment changes (WebKit bug 215884). Each request is a chance for a prompt, so the
// app asks as rarely as possible: the stream is acquired once, handed back to every camera
// screen, and only released after a few minutes of not scanning. Sign-in results come back
// in the query string, never the fragment, for the same reason.
//
// The prompt on the first scan after the app is launched cannot be avoided from a web page.
// The "iPhone Camera" mode (a file input with capture) never asks at all.

const KEEP_ALIVE_MS = 3 * 60_000;

let stream: MediaStream | null = null;
let pending: Promise<MediaStream> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

const live = (s: MediaStream | null): s is MediaStream =>
  !!s && s.getVideoTracks().some((t) => t.readyState === 'live');

/** The shared stream, requesting the camera only if there is no live one. */
export function acquireCamera(): Promise<MediaStream> {
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (live(stream)) {
    stream.getVideoTracks().forEach((t) => (t.enabled = true));
    return Promise.resolve(stream);
  }
  if (pending) return pending;
  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(Object.assign(new Error('This browser does not allow camera access from a web page.'), { name: 'NotSupportedError' }));
  }
  pending = navigator.mediaDevices
    .getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
    })
    .then((s) => {
      stream = s;
      return s;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/**
 * The camera screen closed. Keep the stream (frames paused) for a few minutes so the next
 * "Add page" or scan reuses it without asking again, then let the camera go.
 */
export function releaseCamera(): void {
  if (!stream) return;
  stream.getVideoTracks().forEach((t) => (t.enabled = false));
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(stopCamera, KEEP_ALIVE_MS);
}

export function stopCamera(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

/** True on iPhone/iPad when launched from the Home Screen. */
export function isIosHomeScreenApp(): boolean {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  return ios && standalone;
}
