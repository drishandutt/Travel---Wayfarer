import type { CapacitorConfig } from '@capacitor/cli'

// The iPhone app is a native shell around the live site, not a bundled copy: sign-in is an
// HttpOnly cookie and trips and money stay live over EventSource, which both need the page and
// the API on one origin. So every push to main updates the app too, without an App Store release.
// For dev, point it at your Mac: CAP_SERVER_URL=http://<mac-ip>:5173 npx cap sync ios (with npm run phone).
const url = process.env.CAP_SERVER_URL ?? 'https://wayfarer-production-3acc.up.railway.app'

const config: CapacitorConfig = {
  appId: 'com.drishandutt.wayfarer',
  appName: 'Wayfarer',
  webDir: 'dist', // only used offline, when there's no server; the app loads `url`
  // offline.html is in the bundle, shown when the site can't be reached
  server: { url, cleartext: url.startsWith('http://'), errorPath: 'offline.html' },
  ios: {
    contentInset: 'never', // the CSS handles the notch with env(safe-area-inset-*)
    backgroundColor: '#1d1d1f',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    // the page hides it once it has painted (src/main.tsx); this is the cap if it never does
    SplashScreen: { launchShowDuration: 6000, launchAutoHide: true, launchFadeOutDuration: 200, backgroundColor: '#1d1d1f' },
  },
}

export default config
