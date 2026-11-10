// Settings of the Chrome profile that stop the bubbles and prompts of Chrome itself. They cover
// the page, and Playwright cannot close them. The server writes them into Default/Preferences
// of the persistent profile before the browser starts. Other settings of the profile stay.
import fs from 'node:fs';
import path from 'node:path';

// A tree of Chrome settings.
export interface PrefsTree {
  [key: string]: string | number | boolean | PrefsTree;
}

export const CHROME_PREFS: PrefsTree = {
  // The password manager: "save password?", and the leak check after a login.
  credentials_enable_service: false,
  profile: {
    password_manager_enabled: false,
    password_manager_leak_detection: false,
    // "Restore pages?" after a session that did not close cleanly.
    exit_type: 'Normal',
    exited_cleanly: true,
    // Permission prompts: 2 is "block".
    default_content_setting_values: {
      notifications: 2,
      geolocation: 2,
      media_stream_mic: 2,
      media_stream_camera: 2,
    },
  },
  // The translate bar.
  translate: { enabled: false },
  // "Save address?" and "save card?".
  autofill: { profile_enabled: false, credit_card_enabled: false },
};

function merge(target: PrefsTree, source: PrefsTree): PrefsTree {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object') {
      const current = target[key];
      const child: PrefsTree = current && typeof current === 'object' ? current : {};
      target[key] = child;
      merge(child, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

// Write CHROME_PREFS into the profile. A missing or damaged file gets only CHROME_PREFS.
export function writeChromePrefs(userDataDir: string): string {
  const file = path.join(userDataDir, 'Default', 'Preferences');
  let prefs: unknown = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Chrome writes a new file from the values that it finds.
  }
  const tree: PrefsTree = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs as PrefsTree : {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merge(tree, CHROME_PREFS)));
  return file;
}
