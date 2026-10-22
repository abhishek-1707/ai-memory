/* global window, document, IntersectionObserver, navigator, setTimeout, console */

/**
 * OmniMemory Public Website - Client JavaScript
 * Handles configuration hydration, download actions, accessible navigation, and interactions.
 */

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', initSite);

  function initSite() {
    initConfiguration();
    initMobileNav();
    initScrollSpy();
    initSmoothScroll();
    initCopyButtons();
  }

  /**
   * Hydrate release metadata and manage download button state
   */
  function initConfiguration() {
    const config = window.OMNIMEMORY_CONFIG || {
      version: '0.1.0',
      platform: 'Windows 10 / 11 (64-bit x64)',
      installerName: 'OmniMemory-0.1.0-x64-Setup.exe',
      installerSizeFormatted: '110.8 MB',
      downloadUrl: null,
      repositoryUrl: 'https://github.com/abhishek-1707/ai-memory',
    };

    // Bind text content to data-bind elements
    document.querySelectorAll('[data-bind="version"]').forEach((el) => {
      el.textContent = `v${config.version}`;
    });

    document.querySelectorAll('[data-bind="platform"]').forEach((el) => {
      el.textContent = config.platform;
    });

    document.querySelectorAll('[data-bind="installer-size"]').forEach((el) => {
      el.textContent = config.installerSizeFormatted;
    });

    document.querySelectorAll('[data-bind="installer-name"]').forEach((el) => {
      el.textContent = config.installerName;
    });

    // Hydrate repo links
    if (config.repositoryUrl) {
      document.querySelectorAll('[data-bind="repo-url"]').forEach((el) => {
        el.setAttribute('href', config.repositoryUrl);
      });
    }

    // Hydrate download button and state banner
    const downloadBtn = document.getElementById('primary-download-btn');
    const heroDownloadBtn = document.getElementById('hero-download-btn');
    const statusBanner = document.getElementById('download-status-banner');

    if (
      config.downloadUrl &&
      typeof config.downloadUrl === 'string' &&
      config.downloadUrl.trim() !== ''
    ) {
      // Release is hosted and download URL is available
      if (downloadBtn) {
        downloadBtn.setAttribute('href', config.downloadUrl);
        downloadBtn.setAttribute('download', config.installerName);
        downloadBtn.classList.remove('disabled');
        downloadBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          <span>Download for Windows (${config.installerSizeFormatted})</span>
        `;
        downloadBtn.setAttribute(
          'aria-label',
          `Download OmniMemory v${config.version} installer for Windows x64 (${config.installerSizeFormatted})`,
        );
      }

      if (heroDownloadBtn) {
        heroDownloadBtn.setAttribute('href', config.downloadUrl);
        heroDownloadBtn.setAttribute('download', config.installerName);
        heroDownloadBtn.setAttribute('aria-label', `Download OmniMemory for Windows x64`);
      }

      if (statusBanner) {
        statusBanner.className = 'download-status-banner available';
        statusBanner.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          <div>
            <strong>Official Windows Release Available:</strong> Direct download for version ${config.version} (${config.installerSizeFormatted}) is active and ready.
          </div>
        `;
      }
    } else {
      // Download URL is not configured yet (Release in Windows validation)
      if (downloadBtn) {
        downloadBtn.setAttribute('href', '#download-install-guide');
        downloadBtn.classList.add('btn-secondary');
        downloadBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span>Release in Windows Validation — View Setup Guide</span>
        `;
        downloadBtn.setAttribute(
          'aria-label',
          'Release in Windows validation. View local installation and setup instructions.',
        );
      }

      if (heroDownloadBtn) {
        heroDownloadBtn.setAttribute('href', '#download');
      }

      if (statusBanner) {
        statusBanner.className = 'download-status-banner validation';
        statusBanner.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <div>
            <strong>Release Status:</strong> The Windows x64 NSIS installer (<code>${config.installerName}</code>, ${config.installerSizeFormatted}) is packaged and smoke-tested. A public hosted release URL has not yet been configured. You can build from source or install locally using the steps below.
          </div>
        `;
      }
    }
  }

  /**
   * Accessible Mobile Navigation Menu
   */
  function initMobileNav() {
    const toggle = document.getElementById('mobile-menu-toggle');
    const menu = document.getElementById('nav-menu');

    if (!toggle || !menu) return;

    toggle.addEventListener('click', () => {
      const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!isExpanded));
      menu.classList.toggle('is-open', !isExpanded);
    });

    // Close when clicking any nav link
    menu.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        toggle.setAttribute('aria-expanded', 'false');
        menu.classList.remove('is-open');
      });
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.classList.contains('is-open')) {
        toggle.setAttribute('aria-expanded', 'false');
        menu.classList.remove('is-open');
        toggle.focus();
      }
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (
        menu.classList.contains('is-open') &&
        !menu.contains(e.target) &&
        !toggle.contains(e.target)
      ) {
        toggle.setAttribute('aria-expanded', 'false');
        menu.classList.remove('is-open');
      }
    });
  }

  /**
   * Active Navigation Highlight on Scroll (ScrollSpy)
   */
  function initScrollSpy() {
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.nav-link[href^="#"]');

    if (!('IntersectionObserver' in window) || sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('id');
            navLinks.forEach((link) => {
              if (link.getAttribute('href') === `#${id}`) {
                link.classList.add('active');
                link.setAttribute('aria-current', 'true');
              } else {
                link.classList.remove('active');
                link.removeAttribute('aria-current');
              }
            });
          }
        });
      },
      {
        rootMargin: '-20% 0px -70% 0px',
        threshold: 0,
      },
    );

    sections.forEach((section) => observer.observe(section));
  }

  /**
   * Smooth Scroll and Accessible Focus
   */
  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', function (e) {
        const targetId = this.getAttribute('href');
        if (targetId === '#' || targetId === '') return;

        const targetEl = document.querySelector(targetId);
        if (targetEl) {
          e.preventDefault();
          targetEl.scrollIntoView({ behavior: 'smooth' });
          targetEl.focus({ preventScroll: true });
          if (document.activeElement !== targetEl) {
            targetEl.setAttribute('tabindex', '-1');
            targetEl.focus({ preventScroll: true });
          }
          if (window.history && window.history.pushState) {
            window.history.pushState(null, '', targetId);
          }
        }
      });
    });
  }

  /**
   * Copy button helper for code blocks
   */
  function initCopyButtons() {
    document.querySelectorAll('.code-copy-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetId = btn.getAttribute('data-copy-target');
        const codeEl = targetId
          ? document.getElementById(targetId)
          : btn.parentElement.querySelector('code');
        if (!codeEl) return;

        const text = codeEl.textContent.trim();
        try {
          await navigator.clipboard.writeText(text);
          const originalText = btn.textContent;
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = originalText;
            btn.classList.remove('copied');
          }, 2000);
        } catch (err) {
          console.error('Clipboard copy failed:', err);
        }
      });
    });
  }
})();
