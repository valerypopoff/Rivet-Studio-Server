// Override for rivet/packages/app/src/utils/globals/ioProvider.ts
// Selects HostedIOProvider when in hosted mode

import { BrowserIOProvider } from '../../../../../rivet/packages/app/src/io/BrowserIOProvider.js';
import { type IOProvider } from '../../../../../rivet/packages/app/src/io/IOProvider.js';
import { LegacyBrowserIOProvider } from '../../../../../rivet/packages/app/src/io/LegacyBrowserIOProvider.js';
import { HostedIOProvider } from '../../../io/HostedIOProvider.js';
import { isHostedMode } from '../tauri.js';

let ioProvider: IOProvider;

if (isHostedMode()) {
  ioProvider = new HostedIOProvider();
} else if (BrowserIOProvider.isSupported()) {
  ioProvider = new BrowserIOProvider();
} else {
  ioProvider = new LegacyBrowserIOProvider();
}

export { ioProvider };
