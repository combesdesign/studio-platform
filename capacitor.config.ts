/**
 * Capacitor config for ONE studio's store app. Self-contained on purpose: the Capacitor CLI loads this file on its own,
 * so it can't import the rest of the project. It reads dist-app/app.json, which `npm run build:app -- --studio=<slug>` writes
 * from the studio's config (appId, appName, colours), and builds the app first if dist-app is missing.
 *
 *   STUDIO_SLUG=snowy npx cap sync        (STUDIO_SLUG defaults to snowy)
 *   APP_ID=com.example.app                override the app id (default: derived from the studio website)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const slug = (process.env.STUDIO_SLUG || 'snowy').trim().toLowerCase();
const webDir = 'dist-app';
const infoPath = path.join(process.cwd(), webDir, 'app.json');

interface AppInfo { slug: string; appId: string; appName: string; scheme: string; webUrl: string; colors: { primary: string; ink: string; bg: string } }
const read = (): AppInfo | null => { try { return JSON.parse(readFileSync(infoPath, 'utf8')) as AppInfo; } catch { return null; } };

let info = existsSync(infoPath) ? read() : null;
if (!info || info.slug !== slug) {
  // No (or the wrong studio's) client-only build yet: make it, so `npx cap add ios` works straight after `npm install`.
  execFileSync(process.execPath, ['build.mjs', '--app', `--studio=${slug}`], { stdio: 'inherit', cwd: process.cwd() });
  info = read();
}
if (!info) throw new Error(`Couldn't read ${webDir}/app.json. Run: npm run build:app -- --studio=${slug}`);

const config = {
  appId: info.appId,
  appName: info.appName,
  webDir,
  // Android serves the app from https://localhost, iOS from capacitor://localhost. Relative asset paths work under both.
  server: { androidScheme: 'https', iosScheme: 'capacitor' },
  backgroundColor: info.colors.bg,
  ios: { contentInset: 'never', backgroundColor: info.colors.bg },
  android: { backgroundColor: info.colors.bg, allowMixedContent: false },
  plugins: {
    // The app hides the splash itself once the first screen is painted (src/shared/native.ts).
    SplashScreen: { launchAutoHide: false, launchShowDuration: 0, backgroundColor: info.colors.bg, showSpinner: false, androidScaleType: 'CENTER_CROP', splashFullScreen: true, splashImmersive: false },
    StatusBar: { backgroundColor: info.colors.bg },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
