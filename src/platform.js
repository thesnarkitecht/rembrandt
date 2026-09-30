// Where the app is running: browser or native shell, phone or computer, touch or mouse.
// Sets <html data-app="mobile|desktop|web"> and data-touch so CSS can adapt too.
const ua = navigator.userAgent;
export const isTauri = !!window.__TAURI_INTERNALS__;
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(ua);
// The iPhone, iPad and Android apps (sold in the stores). Desktop-only features are hidden there,
// and purchases follow the store rules.
export const isMobileApp = isTauri && (isIOS || isAndroid);
export const isTouch = matchMedia('(pointer: coarse)').matches;
export const isNarrow = () => matchMedia('(max-width: 860px)').matches;

document.documentElement.dataset.app = isMobileApp ? 'mobile' : isTauri ? 'desktop' : 'web';
if (isTouch) document.documentElement.dataset.touch = '';
