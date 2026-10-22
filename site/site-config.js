/* global window */

/**
 * OmniMemory Public Website Configuration
 *
 * This configuration controls public release metadata and the Windows installer download URL.
 * Set `downloadUrl` to a valid public URL when a signed release is hosted.
 * If `downloadUrl` is null or empty, the site gracefully displays the release-in-validation state.
 */
window.OMNIMEMORY_CONFIG = {
  version: '0.1.0',
  releaseDate: 'October 2026',
  platform: 'Windows 10 / 11 (64-bit x64)',
  targetArch: 'x64',
  installerName: 'OmniMemory-0.1.0-x64-Setup.exe',
  installerSizeBytes: 116170102,
  installerSizeFormatted: '110.8 MB',
  // Configurable download URL. Set to a real release URL when published, e.g.:
  // 'https://github.com/abhishek-1707/ai-memory/releases/download/v0.1.0/OmniMemory-0.1.0-x64-Setup.exe'
  downloadUrl: null,
  repositoryUrl: 'https://github.com/abhishek-1707/ai-memory',
  issuesUrl: 'https://github.com/abhishek-1707/ai-memory/issues',
  documentationUrl: 'https://github.com/abhishek-1707/ai-memory/tree/main/docs',
};
