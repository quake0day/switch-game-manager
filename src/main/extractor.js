const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const settings = require('./settings');
const mtp = require('./mtp');

let cancelFlag = false;
let activeProcess = null;

// Default password list — tried in order, first success wins
const DEFAULT_PASSWORDS = ['gkinto.com', 'gamekegs.com'];

function setCancelFlag(value) {
  cancelFlag = value;
  if (value && activeProcess) {
    try { activeProcess.kill(); } catch {}
  }
}

function isCancelled() {
  return cancelFlag;
}

const GAME_EXTENSIONS = ['.nsp', '.nsz', '.xci', '.xcz'];
const ARCHIVE_REGEX = /\.(rar|zip)$/i;
const MULTIPART_RAR_REGEX = /\.part(\d+)\.rar$/i;

/**
 * Get the shared local output folder.
 * All processed games go into the SAME folder so the user can select-all and copy.
 */
function getOutputDir(targetFolder) {
  if (mtp.isMtpPath(targetFolder)) {
    const staging = path.join(os.homedir(), 'SwitchGames');
    if (!fs.existsSync(staging)) fs.mkdirSync(staging, { recursive: true });
    return staging;
  }
  return targetFolder;
}

/**
 * Process a single game: extract archives (with nested archive support), find game files, copy to shared output folder.
 */
async function processGame(game, targetFolder, onProgress) {
  const { sevenZipPath, rarPassword } = settings.getSettings();
  const outputDir = getOutputDir(targetFolder);

  if (!sevenZipPath || !fs.existsSync(sevenZipPath)) {
    return { success: false, copiedFiles: [], error: `7-Zip 未找到 (配置路径: ${sevenZipPath || '空'})` };
  }

  const tmpDir = path.join(outputDir, '.tmp', game.titleId);
  const copiedFiles = [];

  // Build password list: user-configured first, then defaults
  const passwords = buildPasswordList(rarPassword);

  try {
    let gameFilesToCopy = [...game.gameFiles];
    const errors = [];

    // Extract archives if any
    if (game.rarFiles.length > 0) {
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      for (let i = 0; i < game.rarFiles.length; i++) {
        if (cancelFlag) return { success: false, copiedFiles, error: '已取消' };

        const archiveFile = game.rarFiles[i];
        const archiveName = path.basename(archiveFile);

        onProgress({
          stage: 'extracting',
          message: `正在解压: ${archiveName} (${i + 1}/${game.rarFiles.length})`,
          percent: Math.round(((i) / game.rarFiles.length) * 30),
        });

        try {
          await extractWithPasswordRetry(archiveFile, tmpDir, sevenZipPath, passwords, (pw, attempt, total) => {
            onProgress({
              stage: 'extracting',
              message: `正在解压: ${archiveName} (密码 ${attempt}/${total})`,
              percent: Math.round(((i) / game.rarFiles.length) * 30),
            });
          });
        } catch (err) {
          console.log(`[extractor] Archive failed: ${archiveName}: ${err.message}`);
          errors.push(`${archiveName}: ${err.message}`);
        }
      }

      // --- Two-stage extraction: check for nested archives inside extracted content ---
      const nestedArchives = scanForArchiveFiles(tmpDir);
      if (nestedArchives.length > 0) {
        console.log(`[extractor] Found ${nestedArchives.length} nested archives, extracting...`);
        const nestedTmp = path.join(tmpDir, '__nested__');
        if (!fs.existsSync(nestedTmp)) fs.mkdirSync(nestedTmp, { recursive: true });

        for (let j = 0; j < nestedArchives.length; j++) {
          if (cancelFlag) return { success: false, copiedFiles, error: '已取消' };

          const nestedArchive = nestedArchives[j];
          const nestedName = path.basename(nestedArchive);

          onProgress({
            stage: 'extracting',
            message: `正在解压内层: ${nestedName} (${j + 1}/${nestedArchives.length})`,
            percent: 30 + Math.round(((j) / nestedArchives.length) * 20),
          });

          try {
            await extractWithPasswordRetry(nestedArchive, nestedTmp, sevenZipPath, passwords, (pw, attempt, total) => {
              onProgress({
                stage: 'extracting',
                message: `正在解压内层: ${nestedName} (密码 ${attempt}/${total})`,
                percent: 30 + Math.round(((j) / nestedArchives.length) * 20),
              });
            });
          } catch (err) {
            console.log(`[extractor] Nested archive failed: ${nestedName}: ${err.message}`);
            errors.push(`${nestedName}: ${err.message}`);
          }
        }
      }

      const extracted = scanForGameFiles(tmpDir);
      gameFilesToCopy.push(...extracted);
    }

    if (gameFilesToCopy.length === 0) {
      const errorDetail = errors.length > 0 ? errors.join('; ') : '未找到游戏文件 (NSP/NSZ/XCI/XCZ)';
      return { success: false, copiedFiles: [], error: errorDetail };
    }

    // Copy game files to the shared output folder
    for (let i = 0; i < gameFilesToCopy.length; i++) {
      if (cancelFlag) return { success: false, copiedFiles, error: '已取消' };

      const srcFile = gameFilesToCopy[i];
      const fileName = path.basename(srcFile);
      const destFile = path.join(outputDir, fileName);

      // Skip if duplicate (same name and size)
      if (fs.existsSync(destFile)) {
        const srcStat = fs.statSync(srcFile);
        const destStat = fs.statSync(destFile);
        if (srcStat.size === destStat.size) {
          onProgress({
            stage: 'skipping',
            message: `跳过重复文件: ${fileName}`,
            percent: 60 + Math.round(((i + 1) / gameFilesToCopy.length) * 40),
          });
          copiedFiles.push(destFile);
          continue;
        }
      }

      // If source and dest are on same volume, try rename (instant move)
      if (srcFile.charAt(0).toUpperCase() === outputDir.charAt(0).toUpperCase()) {
        try {
          fs.renameSync(srcFile, destFile);
          copiedFiles.push(destFile);
          onProgress({
            stage: 'copying',
            message: `已移动: ${fileName}`,
            percent: 60 + Math.round(((i + 1) / gameFilesToCopy.length) * 40),
          });
          continue;
        } catch {
          // Fall through to stream copy
        }
      }

      onProgress({
        stage: 'copying',
        message: `正在复制: ${fileName}`,
        percent: 60 + Math.round(((i) / gameFilesToCopy.length) * 40),
      });

      await streamCopy(srcFile, destFile, (copyPercent) => {
        const overall = 60 + Math.round(((i + copyPercent / 100) / gameFilesToCopy.length) * 40);
        onProgress({
          stage: 'copying',
          message: `正在复制: ${fileName} (${copyPercent}%)`,
          percent: overall,
        });
      });

      copiedFiles.push(destFile);
    }

    const warning = errors.length > 0 ? `部分解压失败: ${errors.join('; ')}` : null;
    return { success: true, copiedFiles, error: warning, outputDir };
  } catch (err) {
    return { success: false, copiedFiles, error: err.message };
  } finally {
    try {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Build a deduplicated password list: user password(s) first, then defaults.
 */
function buildPasswordList(userPassword) {
  const list = [];
  // User-configured password(s)
  if (userPassword) {
    for (const pw of userPassword.split(/[,;|]/).map(s => s.trim()).filter(Boolean)) {
      if (!list.includes(pw)) list.push(pw);
    }
  }
  // Append defaults
  for (const pw of DEFAULT_PASSWORDS) {
    if (!list.includes(pw)) list.push(pw);
  }
  return list;
}

/**
 * Try extracting with each password in the list. First success wins.
 * If ALL passwords fail, throw the last error.
 */
async function extractWithPasswordRetry(archiveFile, outputDir, sevenZipPath, passwords, onRetry) {
  let lastError = null;

  // For ZIP files, try without password first (ZIPs are often unencrypted outer containers)
  const isZip = /\.zip$/i.test(archiveFile);
  const passwordsToTry = isZip ? ['', ...passwords.filter(p => p !== '')] : passwords;

  console.log(`[extractor] Will try ${passwordsToTry.length} passwords for ${path.basename(archiveFile)} (isZip=${isZip})`);

  for (let i = 0; i < passwordsToTry.length; i++) {
    const pw = passwordsToTry[i];
    console.log(`[extractor] --- Attempt ${i + 1}/${passwordsToTry.length} with password: "${pw || '(empty)'}" ---`);
    if (onRetry) onRetry(pw || '(无密码)', i + 1, passwordsToTry.length);

    try {
      await extractArchive(archiveFile, outputDir, sevenZipPath, pw);
      console.log(`[extractor] SUCCESS with password ${i + 1}: "${pw}"`);
      return; // Success
    } catch (err) {
      console.log(`[extractor] FAILED password ${i + 1} ("${pw}"): ${err.message}`);
      lastError = err;

      // Only skip retry for errors that are DEFINITELY not password-related
      const skipRetry =
        err.message.includes('无法启动') ||     // Can't launch 7z
        err.message.includes('分卷文件不完整');   // Missing volumes
      if (skipRetry) throw err;

      // Clean up any partial extraction before retrying
      try {
        const entries = fs.readdirSync(outputDir);
        for (const e of entries) {
          fs.rmSync(path.join(outputDir, e), { recursive: true, force: true });
        }
      } catch {}
    }
  }

  throw new Error(`解压失败 (${path.basename(archiveFile)}): ${lastError ? lastError.message : '未知'}`);
}

/**
 * Extract an archive file using 7z.exe.
 */
function extractArchive(archiveFile, outputDir, sevenZipPath, password) {
  return new Promise((resolve, reject) => {
    // Always pass -p to prevent 7z from waiting on stdin for password input
    const args = ['x', '-y', `-p${password}`, archiveFile, `-o${outputDir}`];

    console.log(`[extractor] Running: "${sevenZipPath}" ${args.map((a, i) => i === 2 ? `-p***` : `"${a}"`).join(' ')}`);
    console.log(`[extractor] Actual password: "${password}" (length=${password.length})`);

    const proc = spawn(sevenZipPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeProcess = proc;

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      activeProcess = null;
      console.log(`[extractor] 7z exited code=${code}`);
      console.log(`[extractor] STDERR: ${stderr.slice(-500)}`);
      console.log(`[extractor] STDOUT (tail): ${stdout.slice(-500)}`);
      if (code === 0) {
        resolve();
      } else if (code === 1) {
        // Code 1 = Warning (non-fatal), treat as success
        console.log(`[extractor] 7z warning (code 1), treating as success`);
        resolve();
      } else {
        const allOutput = (stderr + '\n' + stdout).trim();
        let errorMsg = `7z 退出码 ${code}`;

        if (allOutput.includes('Wrong password')) {
          errorMsg = '密码错误';
        } else if (allOutput.includes('CRC Failed')) {
          errorMsg = '文件校验失败（密码错误或文件损坏）';
        } else if (allOutput.includes('Data Error')) {
          errorMsg = '数据错误（密码错误或文件损坏）';
        } else if (allOutput.includes('Headers Error')) {
          errorMsg = '文件头错误（密码错误或文件损坏）';
        } else if (allOutput.includes('Cannot open encrypted archive')) {
          errorMsg = '无法打开加密压缩包（密码错误）';
        } else if (allOutput.includes('Cannot open')) {
          errorMsg = '无法打开文件';
        } else if (allOutput.includes('No more files')) {
          errorMsg = '分卷文件不完整';
        } else {
          // Keep exit code + first ERROR line for debugging
          const lines = allOutput.split('\n').filter(l => l.trim());
          const errorLine = lines.find(l => /^ERROR/i.test(l.trim()));
          if (errorLine) {
            errorMsg += ': ' + errorLine.trim().slice(0, 120);
          }
        }

        reject(new Error(errorMsg));
      }
    });

    proc.on('error', (err) => {
      activeProcess = null;
      reject(new Error(`无法启动 7z: ${err.message}`));
    });
  });
}

/**
 * Scan a directory recursively for archive files (.rar/.zip).
 * For multi-part RARs, only return the first part.
 */
function scanForArchiveFiles(dir) {
  const allArchives = [];
  function walk(d) {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '__nested__') continue; // skip our own nested output dir
        const fullPath = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (ARCHIVE_REGEX.test(entry.name)) {
          allArchives.push(fullPath);
        }
      }
    } catch {}
  }
  walk(dir);

  // Filter: for multi-part RARs keep only part1; skip error txt files misidentified
  const groups = new Map();
  for (const f of allArchives) {
    const basename = path.basename(f);
    const multiMatch = basename.match(MULTIPART_RAR_REGEX);
    if (multiMatch) {
      const base = basename.replace(MULTIPART_RAR_REGEX, '');
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push({ path: f, part: parseInt(multiMatch[1]) });
    } else if (path.extname(f).toLowerCase() === '.zip') {
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

function scanForGameFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanForGameFiles(fullPath));
      } else if (GAME_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  } catch {}
  return results;
}

function streamCopy(src, dest, onCopyProgress) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(src);
    const totalSize = stat.size;
    let copiedSize = 0;
    let lastReportedPercent = -1;

    const readStream = fs.createReadStream(src);
    const writeStream = fs.createWriteStream(dest);

    readStream.on('data', (chunk) => {
      copiedSize += chunk.length;
      const percent = Math.round((copiedSize / totalSize) * 100);
      if (percent !== lastReportedPercent) {
        lastReportedPercent = percent;
        onCopyProgress(percent);
      }
    });

    readStream.on('error', (err) => { writeStream.destroy(); reject(err); });
    writeStream.on('error', (err) => { readStream.destroy(); reject(err); });
    writeStream.on('finish', resolve);
    readStream.pipe(writeStream);
  });
}

module.exports = { processGame, setCancelFlag, isCancelled, getOutputDir, buildPasswordList };
