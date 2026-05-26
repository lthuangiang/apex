/**
 * AppKit browser bundle entry point.
 *
 * Bundled by esbuild into /src/dashboard/public/js/appkit.bundle.js
 * Exposes window.DriftAppKit with open() and disconnect() methods.
 */

import { createAppKit } from '@reown/appkit';
import { mainnet } from '@reown/appkit/networks';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';

const PROJECT_ID = '17746bd693c050df38d432312bc640cc';

const ethersAdapter = new EthersAdapter();

const modal = createAppKit({
  adapters: [ethersAdapter],
  networks: [mainnet],
  projectId: PROJECT_ID,
  metadata: {
    name: 'DRIFT Trading Dashboard',
    description: 'AI-powered perpetual futures trading bot',
    url: typeof window !== 'undefined' ? window.location.origin : 'https://drift.app',
    icons: ['/images/logo.png'],
  },
  features: {
    analytics: false,
    email: false,
    socials: false,
  },
  themeMode: 'dark',
  themeVariables: {
    '--w3m-accent': '#f5a623',
    '--w3m-border-radius-master': '8px',
  },
});

/**
 * Open AppKit modal and wait for wallet connection.
 * Returns { address, provider } on success.
 * Rejects with 'User closed wallet modal' if user dismisses without connecting.
 */
function openAndWait(): Promise<{ address: string; provider: unknown }> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    // Subscribe to account changes — fires when user connects
    const unsubAccount = modal.subscribeAccount((account) => {
      if (account.isConnected && account.address && !resolved) {
        resolved = true;
        unsubAccount();
        unsubState();
        const provider = modal.getWalletProvider();
        resolve({ address: account.address, provider });
      }
    });

    // Subscribe to modal state — detect when user closes without connecting
    const unsubState = modal.subscribeState((state) => {
      if (!state.open && !resolved) {
        // Modal closed — check if connected
        const addr = modal.getAddress();
        if (addr) {
          resolved = true;
          unsubAccount();
          unsubState();
          resolve({ address: addr, provider: modal.getWalletProvider() });
        } else {
          // Not connected — user dismissed
          resolved = true;
          unsubAccount();
          unsubState();
          reject(new Error('User closed wallet modal'));
        }
      }
    });

    // Open the modal
    modal.open().catch((err: unknown) => {
      if (!resolved) {
        resolved = true;
        unsubAccount();
        unsubState();
        reject(err);
      }
    });
  });
}

// Expose to window
(window as any).DriftAppKit = {
  open: openAndWait,
  getProvider: () => modal.getWalletProvider(),
  getAddress: () => modal.getAddress(),
  disconnect: () => modal.disconnect(),
};
