# OmniMemory Public Website

This document covers the architecture, local preview, static build, hosting, release publishing workflow, and configuration of the public marketing website for OmniMemory.

---

## 1. Architecture & Isolation

The OmniMemory public website lives in the `site/` directory. It is strictly separated from the private application dashboard and authenticated backend:

- **Directory isolation**: The public website is located in `site/` and exports to `dist-site/`. The authenticated PWA dashboard is located in `public/` and served at `http://127.0.0.1:3210/` by Fastify.
- **Data isolation**: The public website does not access, bundle, or expose `data/`, SQLite databases, `.env` files, setup codes, bearer tokens, or internal APIs.
- **Network isolation**: The public website is a pure client-side static site. It does not require a backend server, database connection, or permissive CORS configurations.

---

## 2. Previewing the Website Locally

A zero-dependency preview server is provided via Node.js HTTP:

```powershell
npm run site:preview
```

This starts a local static file server at:

```text
http://127.0.0.1:4173/
```

### Preview server details:

- **Default host & port**: `127.0.0.1:4173`
- **Port override**: Set `$env:OMNIMEMORY_SITE_PORT = 5000` before running.
- **Security**: The server only serves files located in `site/`, rejects directory traversal (`..`), and returns security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`).

---

## 3. Building the Production Static Website

To validate and build the production static bundle:

```powershell
npm run site:build
```

### What `site:build` does:

1. Validates that all required assets exist (`index.html`, `styles.css`, `site.js`, `site-config.js`, `assets/icon.svg`).
2. Scans for accessibility markers, semantic structure, and anchor targets.
3. Performs a security scan to ensure no development machine paths (`C:\`, `D:\`), tokens, or environment variables are present.
4. Exports a clean, production-ready bundle into `dist-site/`.

The `dist-site/` folder is ignored by Git and ready for static hosting.

---

## 4. Hosting the Public Static Site

Because the website consists entirely of standard HTML, CSS, JavaScript, and SVG assets, it can be deployed to any static web host without backend infrastructure.

### Option A: GitHub Pages

1. In the repository settings on GitHub, navigate to **Pages**.
2. Select **GitHub Actions** as the source.
3. Configure an action workflow to deploy `dist-site/` on pushes to `main` (or deploy from a `gh-pages` branch).

### Option B: Cloudflare Pages

1. Connect the GitHub repository in the Cloudflare Dashboard.
2. Set build command: `npm run site:build`
3. Set build output directory: `dist-site`

### Option C: Netlify / Vercel

1. Link repository in Netlify or Vercel.
2. Set build command: `npm run site:build`
3. Set publish directory: `dist-site`

---

## 5. Publishing the Windows Installer

When the Windows desktop installer (`OmniMemory-0.1.0-x64-Setup.exe`) has passed physical Windows installation validation:

1. **Build the production installer**:

   ```powershell
   npm run desktop:build
   ```

   Artifact output: `artifacts-v2\OmniMemory-0.1.0-x64-Setup.exe` (NSIS x64 installer, ~110.8 MB).

2. **Run isolated smoke tests**:

   ```powershell
   npm run desktop:smoke
   ```

3. **Validate on Windows**:
   - Install the executable on a clean Windows 10/11 system.
   - Confirm launch, initial setup code input, database creation in `%APPDATA%\OmniMemory`, and loopback binding.

4. **Publish to GitHub Releases**:
   - Create a new release tag (e.g. `v0.1.0`) on GitHub.
   - Upload `OmniMemory-0.1.0-x64-Setup.exe` to the release assets.
   - The direct download URL will follow the GitHub release asset convention:
     `https://github.com/abhishek-1707/ai-memory/releases/download/v0.1.0/OmniMemory-0.1.0-x64-Setup.exe`

---

## 6. Configuring the Download URL

The public website uses `site/site-config.js` to control the download action:

```javascript
window.OMNIMEMORY_CONFIG = {
  version: '0.1.0',
  releaseDate: 'October 2026',
  platform: 'Windows 10 / 11 (64-bit x64)',
  targetArch: 'x64',
  installerName: 'OmniMemory-0.1.0-x64-Setup.exe',
  installerSizeBytes: 116170102,
  installerSizeFormatted: '110.8 MB',

  // Set to null/empty when public binary is in validation:
  downloadUrl:
    'https://github.com/abhishek-1707/ai-memory/releases/download/v0.1.0/OmniMemory-0.1.0-x64-Setup.exe',

  repositoryUrl: 'https://github.com/abhishek-1707/ai-memory',
  issuesUrl: 'https://github.com/abhishek-1707/ai-memory/issues',
  documentationUrl: 'https://github.com/abhishek-1707/ai-memory/tree/main/docs',
};
```

### Download Button Behavior:

- **When `downloadUrl` is `null` or empty**:
  The website displays an honest **"Release in Windows Validation"** state banner and button, pointing users to the installation instructions and local source build guide. No broken links or fake download actions are shown.
- **When `downloadUrl` is configured**:
  The download button immediately activates, displays the file size (`110.8 MB`), sets the HTML `download` attribute to `OmniMemory-0.1.0-x64-Setup.exe`, and links directly to the installer.

---

## 7. Updating the Website for Future Releases

When publishing a new release (e.g., `v0.2.0`):

1. Update `package.json` version.
2. Build the new installer: `npm run desktop:build`.
3. Check the exact artifact size in `artifacts-v2/`.
4. Update `site/site-config.js`:
   - Set `version`: new version string.
   - Set `installerName`: e.g. `OmniMemory-0.2.0-x64-Setup.exe`.
   - Set `installerSizeBytes` and `installerSizeFormatted`.
   - Update `downloadUrl` to the newly published asset URL.
5. Run checks and tests:
   ```powershell
   npm run typecheck
   npm run lint
   npm run format:check
   npx vitest run tests/site.test.ts
   npm run site:build
   ```
6. Deploy the updated `dist-site/` to your static host.
