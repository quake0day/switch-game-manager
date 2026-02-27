const ElectronStore = require('electron-store');

const store = new ElectronStore({
  defaults: {
    sourceFolders: [],
    targetFolder: '',
    sevenZipPath: '',
    rarPassword: 'gkinto.com,gamekegs.com',
  },
});

function getSettings() {
  return {
    sourceFolders: store.get('sourceFolders'),
    targetFolder: store.get('targetFolder'),
    sevenZipPath: store.get('sevenZipPath'),
    rarPassword: store.get('rarPassword'),
  };
}

function setSettings(settings) {
  if (settings.sourceFolders !== undefined) store.set('sourceFolders', settings.sourceFolders);
  if (settings.targetFolder !== undefined) store.set('targetFolder', settings.targetFolder);
  if (settings.sevenZipPath !== undefined) store.set('sevenZipPath', settings.sevenZipPath);
  if (settings.rarPassword !== undefined) store.set('rarPassword', settings.rarPassword);
}

function detect7ZipPath() {
  const fs = require('fs');
  const { execSync } = require('child_process');

  // Check common system install locations (need full 7z.exe for RAR support, NOT 7za.exe)
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    'D:\\Program Files\\7-Zip\\7z.exe',
    'D:\\7-Zip\\7z.exe',
    'E:\\Program Files\\7-Zip\\7z.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Try Windows `where` command
  try {
    const result = execSync('where 7z.exe 2>nul', { encoding: 'utf-8' }).trim();
    if (result && fs.existsSync(result.split('\n')[0].trim())) {
      return result.split('\n')[0].trim();
    }
  } catch {
    // not in PATH
  }

  // Try reading from registry
  try {
    const result = execSync('reg query "HKLM\\SOFTWARE\\7-Zip" /v Path 2>nul', { encoding: 'utf-8' });
    const match = result.match(/Path\s+REG_SZ\s+(.+)/);
    if (match) {
      const regPath = match[1].trim() + '\\7z.exe';
      if (fs.existsSync(regPath)) return regPath;
    }
  } catch {
    // registry key not found
  }

  return '';
}

// Auto-detect on every startup if path is missing or invalid
const fs = require('fs');
const currentPath = store.get('sevenZipPath');
if (!currentPath || !fs.existsSync(currentPath)) {
  const detected = detect7ZipPath();
  if (detected) store.set('sevenZipPath', detected);
}

module.exports = { getSettings, setSettings, detect7ZipPath };
