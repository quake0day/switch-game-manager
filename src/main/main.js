const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const settings = require('./settings');
const titledb = require('./titledb');
const scanner = require('./scanner');
const extractor = require('./extractor');
const organizer = require('./organizer');
const mtp = require('./mtp');

let mainWindow;

// Forward main process console.log to renderer DevTools
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function sendLog(...args) {
  try {
    if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-log', ...args.map(a =>
        typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
      ));
    }
  } catch {}
}

console.log = (...args) => { originalLog(...args); sendLog('[main]', ...args); };
console.error = (...args) => { originalError(...args); sendLog('[main:ERROR]', ...args); };
console.warn = (...args) => { originalWarn(...args); sendLog('[main:WARN]', ...args); };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Switch 游戏文件管理器',
    backgroundColor: '#1a1a2e',
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // Open DevTools with F12
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });
}

app.whenReady().then(async () => {
  await titledb.loadDB();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ==================== IPC Handlers ====================

// Settings
ipcMain.handle('get-settings', () => {
  return settings.getSettings();
});

ipcMain.handle('set-settings', (_event, newSettings) => {
  settings.setSettings(newSettings);
  if (newSettings.sevenZipPath === '') {
    const detected = settings.detect7ZipPath();
    if (detected) settings.setSettings({ sevenZipPath: detected });
  }
  return settings.getSettings();
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Shell folder picker (supports MTP devices like Switch)
ipcMain.handle('select-shell-folder', async () => {
  const folderPath = await mtp.selectShellFolder();
  if (!folderPath) return null;
  const displayName = await mtp.getShellFolderDisplayName(folderPath);
  return { path: folderPath, displayName, isMtp: mtp.isMtpPath(folderPath) };
});

// TitleDB
ipcMain.handle('update-titledb', async () => {
  const count = await titledb.updateDB((msg) => {
    mainWindow.webContents.send('progress', { message: msg, stage: 'downloading' });
  });
  return count;
});

ipcMain.handle('get-titledb-status', () => {
  return titledb.getStatus();
});

// Build scan options (7z path + passwords) for scanner to peek inside archives
function getScanOpts() {
  const s = settings.getSettings();
  return {
    sevenZipPath: s.sevenZipPath,
    passwords: extractor.buildPasswordList(s.rarPassword),
  };
}

// Scanning
ipcMain.handle('scan-folders', () => {
  const { sourceFolders } = settings.getSettings();
  if (!sourceFolders || sourceFolders.length === 0) {
    throw new Error('未配置源文件夹');
  }
  return scanner.scanSourceFolders(sourceFolders, getScanOpts());
});

// Processing
ipcMain.handle('process-games', async (_event, titleIds) => {
  const { targetFolder } = settings.getSettings();
  if (!targetFolder) throw new Error('未配置目标文件夹');

  const { sourceFolders } = settings.getSettings();
  const allGames = scanner.scanSourceFolders(sourceFolders, getScanOpts());

  const gamesToProcess = allGames.filter((g) => titleIds.includes(g.titleId));
  if (gamesToProcess.length === 0) throw new Error('未找到选中的游戏');

  extractor.setCancelFlag(false);
  const results = [];
  let outputDir = null;

  for (let i = 0; i < gamesToProcess.length; i++) {
    if (extractor.isCancelled()) break;

    const game = gamesToProcess[i];

    mainWindow.webContents.send('progress', {
      titleId: game.titleId,
      gameName: game.name,
      gameIndex: i + 1,
      gameTotal: gamesToProcess.length,
      stage: 'starting',
      message: `正在处理: ${game.name} (${i + 1}/${gamesToProcess.length})`,
      percent: 0,
    });

    const result = await extractor.processGame(game, targetFolder, (progress) => {
      mainWindow.webContents.send('progress', {
        titleId: game.titleId,
        gameName: game.name,
        gameIndex: i + 1,
        gameTotal: gamesToProcess.length,
        ...progress,
      });
    });

    if (result.outputDir) outputDir = result.outputDir;
    results.push({ titleId: game.titleId, ...result });
  }

  // If MTP target, return the staging folder so UI can offer to open it
  const isMtpTarget = mtp.isMtpPath(targetFolder);
  if (isMtpTarget && outputDir) {
    return { results, outputDir, isMtp: true };
  }
  return { results, outputDir: targetFolder, isMtp: false };
});

ipcMain.handle('cancel-processing', () => {
  extractor.setCancelFlag(true);
});

// Organize — analyze
ipcMain.handle('organize-analyze', (_event, sourceFolder) => {
  return organizer.analyzeFolder(sourceFolder, getScanOpts());
});

// Organize — execute
ipcMain.handle('organize-execute', (_event, sourceFolder, actions) => {
  return organizer.executeActions(sourceFolder, actions, (progress) => {
    mainWindow.webContents.send('progress', {
      stage: 'organizing',
      message: `整理中 (${progress.current}/${progress.total}): ${progress.action.description}`,
      percent: progress.percent,
    });
  });
});

// Open folder in Explorer
ipcMain.handle('open-folder', (_event, folderPath) => {
  shell.openPath(folderPath);
});
