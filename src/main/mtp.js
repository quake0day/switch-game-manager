const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Detect if a path is a Shell namespace / MTP path (not a regular filesystem path).
 */
function isMtpPath(p) {
  if (!p) return false;
  if (/^[A-Za-z]:[\\\/]/.test(p)) return false;
  if (p.startsWith('\\\\')) return false;
  return true;
}

/**
 * Run a PowerShell script from a temp file to avoid inline script text leaking into errors.
 */
function runPsScript(script, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `sgm-ps-${Date.now()}.ps1`);
    fs.writeFileSync(tmpFile, script, 'utf-8');

    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile,
    ]);

    let output = '';
    let errorOutput = '';
    let timer = null;

    ps.stdout.on('data', (data) => { output += data.toString(); });
    ps.stderr.on('data', (data) => { errorOutput += data.toString(); });

    ps.on('close', (code) => {
      if (timer) clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
      if (code !== 0) {
        // Clean error: only the meaningful part, not the script text
        const cleanError = errorOutput
          .split('\n')
          .filter(l => l.trim() && !l.startsWith('At ') && !l.includes('.ps1:'))
          .map(l => l.replace(/^\s*[\+\~]\s*/, '').trim())
          .filter(Boolean)
          .join(' ')
          .slice(0, 200);
        reject(new Error(cleanError || `PowerShell 退出码 ${code}`));
      } else {
        resolve(output.trim());
      }
    });

    ps.on('error', (err) => {
      if (timer) clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
      reject(new Error(`无法启动 PowerShell: ${err.message}`));
    });

    if (timeout > 0) {
      timer = setTimeout(() => {
        ps.kill();
        try { fs.unlinkSync(tmpFile); } catch {}
        reject(new Error('PowerShell 操作超时'));
      }, timeout);
    }
  });
}

/**
 * Open Windows Shell BrowseForFolder dialog.
 * Can browse MTP devices, unlike Electron's dialog.showOpenDialog.
 */
function selectShellFolder() {
  return new Promise((resolve) => {
    const script = `
[System.Threading.Thread]::CurrentThread.CurrentUICulture = 'zh-CN'
$shell = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder(0, '选择目标文件夹（支持 MTP 设备）', 0x40, 17)
if ($folder -ne $null) {
    Write-Output $folder.Self.Path
}
`;
    // BrowseForFolder is interactive, can't use -NonInteractive, and no timeout
    const tmpFile = path.join(os.tmpdir(), `sgm-browse-${Date.now()}.ps1`);
    fs.writeFileSync(tmpFile, script, 'utf-8');

    const ps = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile,
    ]);

    let output = '';
    ps.stdout.on('data', (data) => { output += data.toString(); });
    ps.stderr.on('data', () => {});
    ps.on('close', () => {
      try { fs.unlinkSync(tmpFile); } catch {}
      resolve(output.trim() || null);
    });
  });
}

/**
 * Get the display name of a shell folder.
 */
async function getShellFolderDisplayName(shellPath) {
  const escaped = shellPath.replace(/'/g, "''");
  const script = `
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace('${escaped}')
if ($folder -ne $null) {
    Write-Output $folder.Self.Name
}
`;
  try {
    const result = await runPsScript(script);
    return result || shellPath;
  } catch {
    return shellPath;
  }
}

/**
 * Copy a local file to a Shell namespace folder (works with MTP devices).
 * Windows will show its native copy progress dialog for large files.
 */
async function copyFileToShell(sourceFile, destShellPath) {
  const escapedSource = sourceFile.replace(/'/g, "''");
  const escapedDest = destShellPath.replace(/'/g, "''");
  const fileName = path.basename(sourceFile).replace(/'/g, "''");

  const script = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$dest = $shell.Namespace('${escapedDest}')
if ($dest -eq $null) {
    Write-Error '无法访问目标文件夹'
    exit 1
}
$dest.CopyHere('${escapedSource}', 0x10)

# Wait for copy to complete
$maxWait = 7200
$waited = 0
$lastSize = -1
while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 2
    $waited += 2
    $item = $dest.ParseName('${fileName}')
    if ($item -ne $null) {
        $currentSize = $item.Size
        if ($currentSize -eq $lastSize -and $currentSize -gt 0) {
            break
        }
        $lastSize = $currentSize
    }
}
Write-Output 'OK'
`;
  // No timeout for large file copies
  await runPsScript(script, { timeout: 0 });
}

/**
 * Check if a file exists in a shell folder.
 */
async function shellFileExists(destShellPath, fileName) {
  const escaped = destShellPath.replace(/'/g, "''");
  const escapedName = fileName.replace(/'/g, "''");
  const script = `
$shell = New-Object -ComObject Shell.Application
$dest = $shell.Namespace('${escaped}')
if ($dest -ne $null) {
    $item = $dest.ParseName('${escapedName}')
    if ($item -ne $null) {
        Write-Output $item.Size
    } else {
        Write-Output 'NOT_FOUND'
    }
} else {
    Write-Output 'NO_ACCESS'
}
`;
  try {
    const result = await runPsScript(script);
    if (result === 'NOT_FOUND' || result === 'NO_ACCESS') {
      return { exists: false, size: 0 };
    }
    return { exists: true, size: parseInt(result) || 0 };
  } catch {
    return { exists: false, size: 0 };
  }
}

module.exports = { isMtpPath, selectShellFolder, getShellFolderDisplayName, copyFileToShell, shellFileExists };
