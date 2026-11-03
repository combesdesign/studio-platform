// Stand-in for @capacitor/* when they aren't installed (this sandbox has no npm registry). build.mjs uses it only then;
// on a real machine the real plugins are bundled. Everything is a harmless no-op.
const noop = async () => undefined;
const listener = async () => ({ remove: noop });
export const Browser = { open: noop, close: noop };
export const App = { addListener: listener, exitApp: noop };
export const StatusBar = { setStyle: noop, setBackgroundColor: noop };
export const Style = { Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' };
export const SplashScreen = { hide: noop, show: noop };
export const PushNotifications = {
  requestPermissions: async () => ({ receive: 'denied' }), checkPermissions: async () => ({ receive: 'prompt' }),
  register: noop, unregister: noop, addListener: listener,
};
