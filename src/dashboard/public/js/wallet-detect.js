/**
 * wallet-detect.js — EIP-6963 dynamic wallet detection for DRIFT login page.
 *
 * Responsibilities:
 *  1. Listen for EIP-6963 announceProvider events (150 ms window)
 *  2. Fall back to legacy window.ethereum if nothing announced
 *  3. Render detected wallets + always-present WalletConnect button
 *  4. Auto-connect when exactly 1 wallet is detected
 *  5. Show "Install MetaMask" fallback when 0 wallets detected
 *
 * Calls into the host page:
 *  - connectWithProvider(provider, address)  — called after EIP-6963 connect
 *  - connectWalletConnect()                  — called when WC button clicked
 *
 * CSS classes used (must already exist in the page stylesheet):
 *  .wallet-btn  .wallet-icon  .wallet-name  .wallet-sub  .chevron
 */

(function () {
  'use strict';

  // ── EIP-6963 provider registry ──────────────────────────────────────────────
  /** @type {Map<string, {info: EIP6963ProviderInfo, provider: EIP1193Provider}>} */
  var providers = new Map();

  // ── WalletConnect SVG icon (inline, no external dependency) ─────────────────
  var WC_ICON_SVG =
    '<svg width="20" height="14" viewBox="0 0 40 25" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M8.19 4.88C14.72-1.63 25.28-1.63 31.81 4.88L32.6 5.67C32.93 6 32.93 6.53 32.6 6.86' +
    'L30.1 9.36C29.93 9.52 29.67 9.52 29.5 9.36L28.42 8.28C23.77 3.63 16.23 3.63 11.58 8.28' +
    'L10.42 9.44C10.25 9.6 9.99 9.6 9.82 9.44L7.32 6.94C6.99 6.61 6.99 6.08 7.32 5.75Z" fill="white"/>' +
    '<path d="M37.35 10.34L39.58 12.57C39.91 12.9 39.91 13.43 39.58 13.76L29.5 23.84' +
    'C29.17 24.17 28.64 24.17 28.31 23.84L21.18 16.71C21.1 16.63 20.97 16.63 20.89 16.71' +
    'L13.76 23.84C13.43 24.17 12.9 24.17 12.57 23.84L2.42 13.76C2.09 13.43 2.09 12.9 2.42 12.57' +
    'L4.65 10.34C4.98 10.01 5.51 10.01 5.84 10.34L12.97 17.47C13.05 17.55 13.18 17.55 13.26 17.47' +
    'L20.39 10.34C20.72 10.01 21.25 10.01 21.58 10.34L28.71 17.47C28.79 17.55 28.92 17.55 29 17.47' +
    'L36.13 10.34C36.49 10.01 37.02 10.01 37.35 10.34Z" fill="white"/>' +
    '</svg>';

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'className') node.className = attrs[k];
        else if (k === 'innerHTML') node.innerHTML = attrs[k];
        else if (k === 'onclick') node.onclick = attrs[k];
        else if (k === 'disabled') node.disabled = attrs[k];
        else if (k === 'title') node.title = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (children) {
      children.forEach(function (c) {
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else if (c) node.appendChild(c);
      });
    }
    return node;
  }

  // ── Build a single wallet button ─────────────────────────────────────────────

  /**
   * @param {object} opts
   * @param {string}   opts.iconContent   — HTML string for the icon cell
   * @param {string}   opts.iconBg        — inline background style for .wallet-icon
   * @param {string}   opts.name          — wallet display name
   * @param {string}   opts.sub           — subtitle text
   * @param {Function} opts.onClick       — click handler
   * @param {string}   [opts.id]          — optional element id
   */
  function buildWalletBtn(opts) {
    var iconDiv = el('div', {
      className: 'wallet-icon',
      innerHTML: opts.iconContent,
    });
    if (opts.iconBg) iconDiv.style.background = opts.iconBg;

    var nameDiv  = el('div', { className: 'wallet-name' }, [opts.name]);
    var subDiv   = el('div', { className: 'wallet-sub'  }, [opts.sub]);
    var infoDiv  = el('div', { className: 'wallet-info' }, [nameDiv, subDiv]);
    var chevron  = el('span', { className: 'chevron' }, ['›']);

    var btn = el('button', {
      className: 'wallet-btn',
      onclick: opts.onClick,
    }, [iconDiv, infoDiv, chevron]);

    if (opts.id) btn.id = opts.id;
    return btn;
  }

  // ── Build WalletConnect button (always shown) ────────────────────────────────

  function buildWCButton() {
    var isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    return buildWalletBtn({
      id: 'btn-walletconnect',
      iconContent: WC_ICON_SVG,
      iconBg: 'linear-gradient(135deg,#3b99fc,#2563eb)',
      name: isMobile ? 'All Wallets' : 'WalletConnect',
      sub: isMobile ? 'MetaMask, Binance, OKX, SafePal & 550+ more' : 'Mobile & hardware wallets · 550+ supported',
      onClick: function () {
        if (typeof window.connectWalletConnect === 'function') {
          window.connectWalletConnect();
        }
      },
    });
  }

  // ── Build "Install MetaMask" fallback link ───────────────────────────────────

  function buildInstallLink() {
    var link = el('a', {
      className: 'install-link',
      href: 'https://metamask.io',
      target: '_blank',
      rel: 'noopener noreferrer',
    }, ['Install MetaMask →']);
    return link;
  }

  // ── Render the wallet list ───────────────────────────────────────────────────

  // Mobile wallet deep-link configs — opens the dApp URL inside the wallet's browser
  var MOBILE_WALLETS = [
    {
      name: 'MetaMask',
      sub: 'Most popular · iOS & Android',
      icon: '<span style="font-size:1.4rem">🦊</span>',
      iconBg: '#f6851b',
      getHref: function () {
        return 'https://metamask.app.link/dapp/' + window.location.host + window.location.pathname;
      },
    },
    {
      name: 'Binance Web3 Wallet',
      sub: 'All Wallets · iOS & Android',
      icon: '<img src="https://public.bnbstatic.com/image/cms/blog/20230912/a4b5c6d7-e8f9-0a1b-2c3d-4e5f6a7b8c9d.png" width="22" height="22" style="border-radius:4px;display:block" alt="Binance" onerror="this.parentNode.innerHTML=\'<span style=\\\"font-size:1.4rem\\\">🟡</span>\'">',
      iconBg: '#F0B90B',
      getHref: function () {
        // Binance app deep link — opens dApp URL inside Binance built-in browser
        return 'bnc://app.binance.com/mp/app?appId=S1001&startPagePath=pages%2Fbrowser%2Findex&startPageQuery=url%3D' + encodeURIComponent(window.location.href);
      },
    },
    {
      name: 'Trust Wallet',
      sub: 'Multi-chain · iOS & Android',
      icon: '<span style="font-size:1.4rem">🛡️</span>',
      iconBg: '#3375BB',
      getHref: function () {
        return 'https://link.trustwallet.com/open_url?coin_id=60&url=' + encodeURIComponent(window.location.href);
      },
    },
    {
      name: 'Rainbow',
      sub: 'iOS & Android',
      icon: '<span style="font-size:1.4rem">🌈</span>',
      iconBg: '#174299',
      getHref: function () {
        return 'https://rnbwapp.com/wc?uri=' + encodeURIComponent(window.location.href);
      },
    },
    {
      name: 'Coinbase Wallet',
      sub: 'iOS & Android',
      icon: '<span style="font-size:1.4rem">🔵</span>',
      iconBg: '#0052FF',
      getHref: function () {
        return 'https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent(window.location.href);
      },
    },
  ];

  function buildMobileButtons(container) {
    MOBILE_WALLETS.forEach(function (w) {
      var btn = buildWalletBtn({
        iconContent: w.icon,
        iconBg: w.iconBg,
        name: w.name,
        sub: w.sub,
        onClick: function () {
          window.location.href = w.getHref();
        },
      });
      container.appendChild(btn);
    });

    var note = document.createElement('p');
    note.style.cssText = 'font-size:.65rem;color:#4a5a72;text-align:center;margin-top:.75rem;line-height:1.5';
    note.textContent = 'Opens your wallet app → connects automatically';
    container.appendChild(note);
  }

  function render() {
    var container = document.getElementById('wallet-list');
    if (!container) return;
    container.innerHTML = '';

    var detected = Array.from(providers.values());
    var isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    // ── 0 wallets detected ───────────────────────────────────────────────────
    if (detected.length === 0) {
      if (isMobile) {
        // Always show static deep-link list immediately (no race condition)
        buildMobileButtons(container);
        // Then append "All Wallets" button for AppKit modal (550+ wallets)
        // This works regardless of whether AppKit has finished loading
        container.appendChild(buildWCButton());
      } else {
        // Desktop: WalletConnect QR + install link
        container.appendChild(buildWCButton());
        container.appendChild(buildInstallLink());
      }
      return;
    }

    // ── 1+ wallets: render each detected wallet ──────────────────────────────
    detected.forEach(function (entry) {
      var info     = entry.info;
      var provider = entry.provider;

      var iconContent = info.icon
        ? '<img src="' + info.icon + '" width="22" height="22" style="border-radius:4px;display:block" alt="' + info.name + '">'
        : '<span style="font-size:1.1rem">🔗</span>';

      var btn = buildWalletBtn({
        iconContent: iconContent,
        iconBg: info.icon ? 'transparent' : '#1e2535',
        name: info.name,
        sub: 'Browser extension · Installed',
        onClick: (function (p, uuid) {
          return function () {
            connectEIP6963(p, uuid);
          };
        })(provider, info.uuid),
      });

      container.appendChild(btn);
    });

    // ── Always append WalletConnect / mobile button at the bottom ────────────
    container.appendChild(buildWCButton());
  }

  // ── Connect via EIP-6963 provider ───────────────────────────────────────────

  function connectEIP6963(provider, uuid) {
    // Disable all wallet buttons while connecting
    var btns = document.querySelectorAll('#wallet-list .wallet-btn');
    btns.forEach(function (b) { b.disabled = true; });

    // Show status box if present
    var statusBox = document.getElementById('status-box');
    if (statusBox) statusBox.classList.add('visible');

    setStep('connect', 'active');

    provider.request({ method: 'eth_requestAccounts' })
      .then(function (accounts) {
        if (!accounts || accounts.length === 0) throw new Error('No accounts returned');
        setStep('connect', 'done');
        // Hand off to the page-level SIWE flow
        if (typeof window.connectWithProvider === 'function') {
          window.connectWithProvider(provider, accounts[0]);
        }
      })
      .catch(function (err) {
        setStep('connect', 'error');
        showPageError(err.message || 'Failed to connect wallet');
        btns.forEach(function (b) { b.disabled = false; });
      });
  }

  // ── Thin wrappers for page-level UI helpers ──────────────────────────────────
  // These mirror the helpers already defined in the page script so wallet-detect.js
  // can call them without duplicating logic.

  function setStep(stepId, state) {
    var step = document.getElementById('step-' + stepId);
    var icon = document.getElementById('step-' + stepId + '-icon');
    if (!step || !icon) return;
    var labels  = { connect: '1', sign: '2', verify: '3' };
    var symbols = { active: '↻', done: '✓', error: '✕' };
    step.className = 'status-step' + (state !== 'pending' ? ' ' + state : '');
    icon.className = 'step-icon ' + state;
    icon.textContent = symbols[state] || labels[stepId] || '';
  }

  function showPageError(msg) {
    var el = document.getElementById('error-msg');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
  }

  // ── EIP-6963 detection ───────────────────────────────────────────────────────

  function startDetection() {
    // Listen for provider announcements
    window.addEventListener('eip6963:announceProvider', function (event) {
      var detail = event.detail;
      if (!detail || !detail.info || !detail.provider) return;
      var uuid = detail.info.uuid;
      if (!uuid || providers.has(uuid)) return; // deduplicate
      providers.set(uuid, { info: detail.info, provider: detail.provider });
    });

    // Request all providers to announce themselves
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    // After 150 ms, finalize the list
    setTimeout(function () {
      // Legacy fallback: if nothing announced but window.ethereum exists
      if (providers.size === 0 && window.ethereum) {
        var legacyUuid = 'legacy-window-ethereum';
        providers.set(legacyUuid, {
          info: {
            uuid: legacyUuid,
            name: 'Browser Wallet',
            icon: '',          // no icon for legacy
            rdns: 'legacy',
          },
          provider: window.ethereum,
        });
      }

      render();

      // Auto-connect if exactly 1 wallet detected
      if (providers.size === 1) {
        var only = Array.from(providers.values())[0];
        connectEIP6963(only.provider, only.info.uuid);
      }
    }, 150);
  }

  // ── Expose disconnect helper so the page can reset the list ─────────────────
  // The existing window.disconnect in the page script handles UI state;
  // we just need to re-enable the buttons.
  var _origDisconnect = window.disconnect;
  window.disconnect = function () {
    if (typeof _origDisconnect === 'function') _origDisconnect();
    // Re-enable all wallet buttons
    var btns = document.querySelectorAll('#wallet-list .wallet-btn');
    btns.forEach(function (b) { b.disabled = false; });
  };

  // ── Boot ─────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDetection);
  } else {
    startDetection();
  }
})();
