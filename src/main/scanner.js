const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const titledb = require('./titledb');

const TITLE_ID_REGEX = /\[([0-9A-Fa-f]{16})\]/;
const GAME_EXTENSIONS = ['.nsp', '.nsz', '.xci', '.xcz'];
const ARCHIVE_REGEX = /\.(rar|zip)$/i;
const MULTIPART_RAR_REGEX = /\.part(\d+)\.rar$/i;

/**
 * @param {string[]} sourceFolders
 * @param {{ sevenZipPath: string, passwords: string[] }} opts
 */
function scanSourceFolders(sourceFolders, opts = {}) {
  const games = new Map();

  for (const sourceFolder of sourceFolders) {
    if (!fs.existsSync(sourceFolder)) continue;

    let entries;
    try {
      entries = fs.readdirSync(sourceFolder, { withFileTypes: true });
    } catch {
      continue;
    }

    // --- Scan subdirectories ---
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(sourceFolder, entry.name);
        const files = scanDirectory(subDir);
        addFilesToGames(games, files, entry.name, [subDir], null, opts);
      }
    }

    // --- Scan game files (.nsp/.nsz/.xci/.xcz) directly in root folder ---
    const rootGameFiles = entries
      .filter((e) => !e.isDirectory() && GAME_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(sourceFolder, e.name));

    for (const gameFile of rootGameFiles) {
      const basename = path.basename(gameFile);
      const match = basename.match(TITLE_ID_REGEX);
      if (!match) continue;
      const titleId = match[1].toUpperCase();
      addFilesToGames(games, [gameFile], basename, [sourceFolder], titleId, opts);
    }

    // --- Scan archive files (.rar/.zip) directly in root folder ---
    const rootArchives = entries
      .filter((e) => !e.isDirectory() && ARCHIVE_REGEX.test(e.name))
      .map((e) => path.join(sourceFolder, e.name));

    for (const archivePath of rootArchives) {
      const basename = path.basename(archivePath);

      // Skip multi-part RARs that aren't part1 (they'll be handled via part1)
      const multiMatch = basename.match(MULTIPART_RAR_REGEX);
      if (multiMatch && parseInt(multiMatch[1]) !== 1) continue;

      // Try Title ID from filename first
      const match = basename.match(TITLE_ID_REGEX);
      let titleId = match ? match[1].toUpperCase() : null;

      // If no Title ID in filename, peek inside the archive
      if (!titleId && opts.sevenZipPath) {
        const peekResult = peekArchive(archivePath, opts.sevenZipPath, opts.passwords || []);
        if (peekResult) titleId = peekResult;
      }

      if (!titleId) continue;

      // For root archives, gather all parts of the same multi-part set
      let archiveFiles = [archivePath];
      if (multiMatch) {
        const prefix = basename.replace(MULTIPART_RAR_REGEX, '');
        archiveFiles = rootArchives.filter((a) => {
          const n = path.basename(a);
          return n.startsWith(prefix) && MULTIPART_RAR_REGEX.test(n);
        });
      }

      addFilesToGames(games, archiveFiles, basename, [sourceFolder], titleId, opts);
    }
  }

  return Array.from(games.values());
}

/**
 * Use `7z l` to list archive contents and find Title IDs from inner file names.
 * Tries each password until one works.
 */
function peekArchive(archivePath, sevenZipPath, passwords) {
  const allPasswords = [...passwords];
  // Ensure we always have at least empty password
  if (!allPasswords.includes('')) allPasswords.push('');

  for (const pw of allPasswords) {
    const args = ['l', `-p${pw}`, archivePath];

    const result = spawnSync(sevenZipPath, args, {
      encoding: 'utf-8',
      timeout: 15000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status !== 0) continue;
    if (!result.stdout) continue;

    // Search the listing for Title IDs and game file extensions
    const lines = result.stdout.split('\n');
    for (const line of lines) {
      const tidMatch = line.match(TITLE_ID_REGEX);
      if (tidMatch) return tidMatch[1].toUpperCase();
    }

    // Fallback: look for game file extensions and try to extract some ID
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (GAME_EXTENSIONS.some((ext) => lower.includes(ext))) {
        // Found a game file but no Title ID pattern — try a looser hex match
        const hexMatch = line.match(/([0-9A-Fa-f]{16})/);
        if (hexMatch) return hexMatch[1].toUpperCase();
      }
    }
  }
  return null;
}

/**
 * Add files to the games map, extracting or using a given Title ID.
 */
function addFilesToGames(games, files, folderName, sourceDirs, forceTitleId, opts) {
  let titleId = forceTitleId || null;

  if (!titleId) {
    // Try to extract Title ID from file names
    for (const f of files) {
      const match = path.basename(f).match(TITLE_ID_REGEX);
      if (match) {
        titleId = match[1].toUpperCase();
        break;
      }
    }
  }
  if (!titleId) {
    const dirMatch = folderName.match(TITLE_ID_REGEX);
    if (dirMatch) titleId = dirMatch[1].toUpperCase();
  }

  // If still no Title ID, peek inside archives in the file list
  if (!titleId && opts && opts.sevenZipPath) {
    for (const f of files) {
      if (ARCHIVE_REGEX.test(f)) {
        const peekResult = peekArchive(f, opts.sevenZipPath, opts.passwords || []);
        if (peekResult) {
          titleId = peekResult;
          break;
        }
      }
    }
  }

  if (!titleId) return;

  const archiveFiles = files.filter((f) => ARCHIVE_REGEX.test(f));
  const gameFiles = files.filter((f) => GAME_EXTENSIONS.includes(path.extname(f).toLowerCase()));

  if (archiveFiles.length === 0 && gameFiles.length === 0) return;

  const extractableArchives = filterExtractableArchives(archiveFiles);
  const dbInfo = titledb.lookupTitle(titleId);

  const existing = games.get(titleId);
  if (existing) {
    existing.rarFiles.push(...extractableArchives);
    existing.gameFiles.push(...gameFiles);
    existing.allRarFiles.push(...archiveFiles);
    for (const d of sourceDirs) {
      if (!existing.sourceDirs.includes(d)) existing.sourceDirs.push(d);
    }
  } else {
    games.set(titleId, {
      titleId,
      name: dbInfo ? dbInfo.name : `Unknown (${titleId})`,
      iconUrl: dbInfo ? dbInfo.iconUrl : '',
      publisher: dbInfo ? dbInfo.publisher : '',
      sourceDirs: [...sourceDirs],
      rarFiles: [...extractableArchives],
      allRarFiles: [...archiveFiles],
      gameFiles: [...gameFiles],
      folderName,
    });
  }
}

function scanDirectory(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanDirectory(fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch {}
  return results;
}

function filterExtractableArchives(archiveFiles) {
  const groups = new Map();

  for (const f of archiveFiles) {
    const basename = path.basename(f);
    const ext = path.extname(f).toLowerCase();
    const multiMatch = basename.match(MULTIPART_RAR_REGEX);

    if (multiMatch) {
      const base = basename.replace(MULTIPART_RAR_REGEX, '');
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push({ path: f, part: parseInt(multiMatch[1]) });
    } else if (ext === '.zip') {
      groups.set(f, [{ path: f, part: 0 }]);
    } else {
      const base = basename.replace(/\.rar$/i, '');
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push({ path: f, part: 0 });
    }
  }

  const result = [];
  for (const files of groups.values()) {
    files.sort((a, b) => a.part - b.part);
    result.push(files[0].path);
  }
  return result;
}

module.exports = { scanSourceFolders, peekArchive, TITLE_ID_REGEX, GAME_EXTENSIONS, ARCHIVE_REGEX, MULTIPART_RAR_REGEX };
