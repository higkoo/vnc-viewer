import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.higkoo.vncviewer',
  appName: 'VNC Viewer',
  webDir: 'capacitor/web',
  bundledWebRuntime: false,
  android: {
    buildOptions: {
      signingType: 'apksigner',
    },
  },
  server: {
    cleartext: true,
    allowNavigation: ['*'],
  },
};

export default config;
