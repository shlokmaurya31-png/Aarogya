import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.aparix.aarogya",
  appName: "Aarogya",
  webDir: "public",
  server: {
    url: "https://aarogya-ai-pi.vercel.app",
    androidScheme: "https",
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
