const fs = require('fs');
const path = require('path');
const titledb = require('./titledb');
const { peekArchive, TITLE_ID_REGEX, GAME_EXTENSIONS, ARCHIVE_REGEX, MULTIPART_RAR_REGEX } = require('./scanner');

const JUNK_PATTERNS = ['.tmp', '.DS_Store', 'Thumbs.db', 'Desktop.lnk', 'desktop.ini'];

function toGameBaseTitleId(titleId) {
  return titleId.slice(0, 12).toUpperCase() + '0000';
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_');
}

function buildGameFolderName(gameName, baseTitleId) {
  return `${sanitizeFileName(gameName)} [${baseTitleId}]`;
}

/**
 * Recursively scan a directory for all files.
 */
function scanDir(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanDir(fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch {}
  return results;
}

/**
 * Try to find a Title ID from files inside a directory.
 */
function findTitleIdInDir(dir, opts) {
  const files = scanDir(dir);
  for (const f of files) {
    const match = path.basename(f).match(TITLE_ID_REGEX);
    if (match) return match[1].toUpperCase();
  }
  // Peek into archives
  if (opts && opts.sevenZipPath) {
    for (const f of files) {
      if (ARCHIVE_REGEX.test(f)) {
        const result = peekArchive(f, opts.sevenZipPath, opts.passwords || []);
        if (result) return result;
      }
    }
  }
  return null;
}

/**
 * Check if a directory is a "pure numeric" folder name (only digits).
 */
function isNumericFolder(name) {
  return /^\d+$/.test(name);
}

/**
 * Check if a folder has double-nesting: X/X/ where X is the only subfolder.
 */
function detectDoubleNesting(dirPath, folderName) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const subDirs = entries.filter(e => e.isDirectory());
    // The folder has exactly one subfolder with the same name
    if (subDirs.length === 1 && subDirs[0].name === folderName) {
      return true;
    }
    // Also handle case where subfolder has same name and root has no other meaningful files
    if (subDirs.length === 1 && isNumericFolder(subDirs[0].name) && subDirs[0].name === folderName) {
      return true;
    }
  } catch {}
  return false;
}

/**
 * Analyze a source folder and return planned actions.
 * @param {string} sourceFolder - Path to the source folder
 * @param {object} opts - { sevenZipPath, passwords }
 * @returns {{ actions: Array, summary: object }}
 */
function analyzeFolder(sourceFolder, opts = {}) {
  const actions = [];

  if (!fs.existsSync(sourceFolder)) {
    return { actions, summary: { total: 0 } };
  }

  let entries;
  try {
    entries = fs.readdirSync(sourceFolder, { withFileTypes: true });
  } catch {
    return { actions, summary: { total: 0 } };
  }

  // Track which base title IDs map to which folder names (for move targets)
  const titleIdToFolder = new Map();

  // --- Pass 1: Analyze directories ---
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderName = entry.name;
    const dirPath = path.join(sourceFolder, folderName);

    // Skip junk directories
    if (JUNK_PATTERNS.includes(folderName)) {
      actions.push({
        type: 'delete_junk',
        description: `删除垃圾目录: ${folderName}/`,
        sourcePath: dirPath,
        isDirectory: true,
      });
      continue;
    }

    // Already has [TitleID] format — skip renaming
    if (TITLE_ID_REGEX.test(folderName)) {
      const match = folderName.match(TITLE_ID_REGEX);
      if (match) {
        const baseId = toGameBaseTitleId(match[1].toUpperCase());
        titleIdToFolder.set(baseId, folderName);
      }
      continue;
    }

    // Check for double nesting: folderName/folderName/
    const isNested = detectDoubleNesting(dirPath, folderName);

    // Try to find Title ID inside the directory
    const scanTarget = isNested ? path.join(dirPath, folderName) : dirPath;
    const titleId = findTitleIdInDir(scanTarget, opts);

    if (!titleId) continue;

    const baseTitleId = toGameBaseTitleId(titleId);
    const dbInfo = titledb.lookupTitle(baseTitleId);
    const gameName = dbInfo ? dbInfo.name : `Unknown (${baseTitleId})`;
    const newFolderName = buildGameFolderName(gameName, baseTitleId);

    if (isNested) {
      actions.push({
        type: 'flatten_nested',
        description: `整理嵌套: ${folderName}/${folderName}/ → ${newFolderName}/`,
        sourcePath: dirPath,
        innerDir: path.join(dirPath, folderName),
        newName: newFolderName,
        targetPath: path.join(sourceFolder, newFolderName),
        titleId: baseTitleId,
        gameName,
      });
    } else {
      actions.push({
        type: 'rename_folder',
        description: `重命名: ${folderName}/ → ${newFolderName}/`,
        sourcePath: dirPath,
        newName: newFolderName,
        targetPath: path.join(sourceFolder, newFolderName),
        titleId: baseTitleId,
        gameName,
      });
    }

    titleIdToFolder.set(baseTitleId, newFolderName);
  }

  // --- Pass 2: Analyze root-level files ---
  const rootFiles = entries.filter(e => !e.isDirectory());

  // Group loose game files by base Title ID
  const looseGameFiles = new Map(); // baseTitleId -> [filePaths]

  for (const entry of rootFiles) {
    const fileName = entry.name;
    const filePath = path.join(sourceFolder, fileName);
    const ext = path.extname(fileName).toLowerCase();

    // Junk files
    if (JUNK_PATTERNS.includes(fileName)) {
      actions.push({
        type: 'delete_junk',
        description: `删除垃圾文件: ${fileName}`,
        sourcePath: filePath,
        isDirectory: false,
      });
      continue;
    }

    // Loose game files (.nsp, .nsz, .xci, .xcz)
    if (GAME_EXTENSIONS.includes(ext)) {
      const match = fileName.match(TITLE_ID_REGEX);
      if (match) {
        const baseTitleId = toGameBaseTitleId(match[1].toUpperCase());
        if (!looseGameFiles.has(baseTitleId)) looseGameFiles.set(baseTitleId, []);
        looseGameFiles.get(baseTitleId).push(filePath);
      }
      continue;
    }

    // Loose archive files (.zip, .rar)
    if (ARCHIVE_REGEX.test(fileName)) {
      // Skip non-part1 multi-part RARs
      const multiMatch = fileName.match(MULTIPART_RAR_REGEX);
      if (multiMatch && parseInt(multiMatch[1]) !== 1) continue;

      // Try to find Title ID
      let titleId = null;
      const tidMatch = fileName.match(TITLE_ID_REGEX);
      if (tidMatch) {
        titleId = tidMatch[1].toUpperCase();
      } else if (opts.sevenZipPath) {
        titleId = peekArchive(filePath, opts.sevenZipPath, opts.passwords || []);
      }

      if (!titleId) continue;

      const baseTitleId = toGameBaseTitleId(titleId);
      const dbInfo = titledb.lookupTitle(baseTitleId);
      const gameName = dbInfo ? dbInfo.name : `Unknown (${baseTitleId})`;
      const targetFolderName = titleIdToFolder.get(baseTitleId) || buildGameFolderName(gameName, baseTitleId);
      titleIdToFolder.set(baseTitleId, targetFolderName);

      // Gather all parts for multi-part RAR
      let filesToMove = [filePath];
      if (multiMatch) {
        const prefix = fileName.replace(MULTIPART_RAR_REGEX, '');
        filesToMove = rootFiles
          .filter(e => {
            const n = e.name;
            return n.startsWith(prefix) && MULTIPART_RAR_REGEX.test(n);
          })
          .map(e => path.join(sourceFolder, e.name));
      }

      const fileNames = filesToMove.map(f => path.basename(f));
      actions.push({
        type: 'move_zip',
        description: `移入ZIP: ${fileNames.join(', ')} → ${targetFolderName}/`,
        files: filesToMove,
        targetDir: path.join(sourceFolder, targetFolderName),
        targetFolderName,
        titleId: baseTitleId,
        gameName,
      });
    }
  }

  // Create move_files actions for grouped loose game files
  for (const [baseTitleId, files] of looseGameFiles) {
    const dbInfo = titledb.lookupTitle(baseTitleId);
    const gameName = dbInfo ? dbInfo.name : `Unknown (${baseTitleId})`;
    const targetFolderName = titleIdToFolder.get(baseTitleId) || buildGameFolderName(gameName, baseTitleId);
    titleIdToFolder.set(baseTitleId, targetFolderName);

    const fileNames = files.map(f => path.basename(f));
    actions.push({
      type: 'move_files',
      description: `移入游戏文件: ${fileNames.length}个文件 → ${targetFolderName}/`,
      files,
      fileNames,
      targetDir: path.join(sourceFolder, targetFolderName),
      targetFolderName,
      titleId: baseTitleId,
      gameName,
    });
  }

  // Build summary
  const summary = {
    total: actions.length,
    rename_folder: actions.filter(a => a.type === 'rename_folder').length,
    flatten_nested: actions.filter(a => a.type === 'flatten_nested').length,
    move_zip: actions.filter(a => a.type === 'move_zip').length,
    move_files: actions.filter(a => a.type === 'move_files').length,
    delete_junk: actions.filter(a => a.type === 'delete_junk').length,
  };

  return { actions, summary };
}

/**
 * Execute planned actions.
 * @param {string} sourceFolder
 * @param {Array} actions
 * @param {function} onProgress
 * @returns {{ results: Array, errors: Array }}
 */
function executeActions(sourceFolder, actions, onProgress) {
  const results = [];
  const errors = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (onProgress) {
      onProgress({
        current: i + 1,
        total: actions.length,
        action,
        percent: Math.round(((i + 1) / actions.length) * 100),
      });
    }

    try {
      switch (action.type) {
        case 'rename_folder': {
          if (fs.existsSync(action.targetPath)) {
            throw new Error(`目标已存在: ${action.newName}`);
          }
          fs.renameSync(action.sourcePath, action.targetPath);
          results.push({ action, success: true });
          break;
        }

        case 'flatten_nested': {
          if (fs.existsSync(action.targetPath)) {
            throw new Error(`目标已存在: ${action.newName}`);
          }
          // Rename outer to temp name to avoid conflict
          const tempName = `__temp_flatten_${Date.now()}`;
          const tempPath = path.join(sourceFolder, tempName);
          fs.renameSync(action.sourcePath, tempPath);
          // Move inner directory out
          const innerInTemp = path.join(tempPath, path.basename(action.innerDir));
          fs.renameSync(innerInTemp, action.targetPath);
          // Remove the now-empty outer shell
          try {
            fs.rmSync(tempPath, { recursive: true, force: true });
          } catch {}
          results.push({ action, success: true });
          break;
        }

        case 'move_zip':
        case 'move_files': {
          // Ensure target directory exists
          if (!fs.existsSync(action.targetDir)) {
            fs.mkdirSync(action.targetDir, { recursive: true });
          }
          for (const file of action.files) {
            const dest = path.join(action.targetDir, path.basename(file));
            if (fs.existsSync(dest)) {
              // Skip if destination already exists
              continue;
            }
            fs.renameSync(file, dest);
          }
          results.push({ action, success: true });
          break;
        }

        case 'delete_junk': {
          if (action.isDirectory) {
            fs.rmSync(action.sourcePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(action.sourcePath);
          }
          results.push({ action, success: true });
          break;
        }

        default:
          results.push({ action, success: false, error: `未知操作类型: ${action.type}` });
      }
    } catch (err) {
      results.push({ action, success: false, error: err.message });
      errors.push({ action, error: err.message });
    }
  }

  return { results, errors };
}

module.exports = { analyzeFolder, executeActions };
