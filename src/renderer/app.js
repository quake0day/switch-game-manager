// State
let games = [];
let selectedIds = new Set();
let isProcessing = false;

// DOM elements
const settingsPanel = document.getElementById('settings-panel');
const btnSettings = document.getElementById('btn-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnAddSource = document.getElementById('btn-add-source');
const btnSelectTarget = document.getElementById('btn-select-target');
const btnDetect7z = document.getElementById('btn-detect-7z');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnUpdateTitleDB = document.getElementById('btn-update-titledb');
const btnScan = document.getElementById('btn-scan');
const btnSelectAll = document.getElementById('btn-select-all');
const btnProcess = document.getElementById('btn-process');
const btnCancel = document.getElementById('btn-cancel');
const sourceFoldersList = document.getElementById('source-folders-list');
const inputTarget = document.getElementById('input-target');
const input7z = document.getElementById('input-7z');
const inputPassword = document.getElementById('input-password');
const titledbInfo = document.getElementById('titledb-info');
const scanStatus = document.getElementById('scan-status');
const gameGrid = document.getElementById('game-grid');
const progressContainer = document.getElementById('progress-container');
const progressTitle = document.getElementById('progress-title');
const progressPercent = document.getElementById('progress-percent');
const progressFill = document.getElementById('progress-fill');
const progressMessage = document.getElementById('progress-message');

// Current settings (cached)
let currentSettings = {
  sourceFolders: [],
  targetFolder: '',
  sevenZipPath: '',
  rarPassword: 'gkinto.com',
};

// ==================== Settings ====================

btnSettings.addEventListener('click', async () => {
  currentSettings = await window.api.getSettings();
  renderSettings();
  settingsPanel.classList.remove('hidden');
});

btnCloseSettings.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
});

settingsPanel.addEventListener('click', (e) => {
  if (e.target === settingsPanel) settingsPanel.classList.add('hidden');
});

btnAddSource.addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (folder) {
    currentSettings.sourceFolders.push(folder);
    renderSourceFolders();
  }
});

btnSelectTarget.addEventListener('click', async () => {
  // Use Shell BrowseForFolder dialog - supports both local folders and MTP devices (e.g. Switch)
  const result = await window.api.selectShellFolder();
  if (result) {
    currentSettings.targetFolder = result.path;
    inputTarget.value = result.isMtp
      ? `[MTP] ${result.displayName}`
      : result.path;
    inputTarget.title = result.path;
  }
});

btnDetect7z.addEventListener('click', async () => {
  // Save empty to trigger re-detection
  await window.api.setSettings({ sevenZipPath: '' });
  const settings = await window.api.getSettings();
  if (settings.sevenZipPath) {
    input7z.value = settings.sevenZipPath;
    currentSettings.sevenZipPath = settings.sevenZipPath;
  } else {
    alert('未检测到 7-Zip，请手动指定路径');
  }
});

btnSaveSettings.addEventListener('click', async () => {
  currentSettings.sevenZipPath = input7z.value;
  currentSettings.rarPassword = inputPassword.value;
  await window.api.setSettings(currentSettings);
  settingsPanel.classList.add('hidden');
});

btnUpdateTitleDB.addEventListener('click', async () => {
  titledbInfo.textContent = '正在更新...';
  btnUpdateTitleDB.disabled = true;
  try {
    await window.api.updateTitleDB();
    await refreshTitleDBStatus();
  } catch (err) {
    titledbInfo.textContent = '更新失败: ' + err.message;
  }
  btnUpdateTitleDB.disabled = false;
});

function renderSettings() {
  renderSourceFolders();
  const target = currentSettings.targetFolder || '';
  // Detect MTP path for display (doesn't start with drive letter)
  const isMtp = target && !/^[A-Za-z]:[\\\/]/.test(target) && !target.startsWith('\\\\');
  inputTarget.value = isMtp ? `[MTP] ${target.split('\\').pop() || target}` : target;
  inputTarget.title = target;
  input7z.value = currentSettings.sevenZipPath || '';
  inputPassword.value = currentSettings.rarPassword || '';
  refreshTitleDBStatus();
}

function renderSourceFolders() {
  sourceFoldersList.innerHTML = '';
  for (let i = 0; i < currentSettings.sourceFolders.length; i++) {
    const folder = currentSettings.sourceFolders[i];
    const item = document.createElement('div');
    item.className = 'folder-item';
    item.innerHTML = `
      <span class="path" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
      <button class="btn-remove" data-index="${i}" title="删除">✕</button>
    `;
    sourceFoldersList.appendChild(item);
  }
  // Bind remove buttons
  sourceFoldersList.querySelectorAll('.btn-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      currentSettings.sourceFolders.splice(idx, 1);
      renderSourceFolders();
    });
  });
}

async function refreshTitleDBStatus() {
  const status = await window.api.getTitleDBStatus();
  if (status.loaded) {
    const date = status.lastModified ? new Date(status.lastModified).toLocaleDateString('zh-CN') : '未知';
    titledbInfo.textContent = `已加载 ${status.entryCount} 条记录 (更新于 ${date})`;
  } else if (status.exists) {
    titledbInfo.textContent = '数据库文件存在但未加载';
  } else {
    titledbInfo.textContent = '未下载，请点击「更新数据库」';
  }
}

// ==================== Scanning ====================

btnScan.addEventListener('click', async () => {
  btnScan.disabled = true;
  scanStatus.textContent = '正在扫描...';
  gameGrid.innerHTML = '';
  games = [];
  selectedIds.clear();
  updateToolbarState();

  try {
    games = await window.api.scanFolders();
    scanStatus.textContent = `找到 ${games.length} 个游戏`;
    renderGameGrid();
  } catch (err) {
    scanStatus.textContent = '扫描失败: ' + err.message;
  }

  btnScan.disabled = false;
  updateToolbarState();
});

// ==================== Game Grid ====================

function renderGameGrid() {
  gameGrid.innerHTML = '';

  if (games.length === 0) {
    gameGrid.innerHTML = `
      <div class="empty-state">
        <p>未找到游戏文件</p>
        <p class="hint">请检查源文件夹是否配置正确</p>
      </div>
    `;
    return;
  }

  for (const game of games) {
    const card = document.createElement('div');
    card.className = 'game-card' + (selectedIds.has(game.titleId) ? ' selected' : '');
    card.dataset.titleId = game.titleId;

    if (game.status) {
      card.classList.add(game.status);
    }

    const rarCount = game.rarFiles ? game.rarFiles.length : 0;
    const gameFileCount = game.gameFiles ? game.gameFiles.length : 0;
    let filesDesc = [];
    if (rarCount > 0) filesDesc.push(`${rarCount} 个RAR`);
    if (gameFileCount > 0) filesDesc.push(`${gameFileCount} 个游戏文件`);

    const errorHtml = game.status === 'error' && game.errorMessage
      ? `<div class="card-error" title="${escapeHtml(game.errorMessage)}">${escapeHtml(game.errorMessage)}</div>`
      : '';

    card.innerHTML = `
      <div class="card-check">${selectedIds.has(game.titleId) ? '✓' : ''}</div>
      ${game.status ? `<div class="card-status status-${game.status}">${statusLabel(game.status)}</div>` : ''}
      <div class="card-cover">
        ${game.iconUrl
          ? `<img src="${escapeHtml(game.iconUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=placeholder>🎮</span>'">`
          : '<span class="placeholder">🎮</span>'
        }
      </div>
      <div class="card-info">
        <div class="card-title" title="${escapeHtml(game.name)}">${escapeHtml(game.name)}</div>
        <div class="card-meta">${game.titleId}</div>
        <div class="card-files">${filesDesc.join(' | ')}</div>
        ${errorHtml}
      </div>
    `;

    card.addEventListener('click', () => {
      if (isProcessing) return;
      if (selectedIds.has(game.titleId)) {
        selectedIds.delete(game.titleId);
        card.classList.remove('selected');
        card.querySelector('.card-check').textContent = '';
      } else {
        selectedIds.add(game.titleId);
        card.classList.add('selected');
        card.querySelector('.card-check').textContent = '✓';
      }
      updateToolbarState();
    });

    gameGrid.appendChild(card);
  }
}

function statusLabel(status) {
  const labels = {
    pending: '待处理',
    processing: '处理中',
    completed: '已完成',
    error: '错误',
  };
  return labels[status] || status;
}

// ==================== Select All ====================

btnSelectAll.addEventListener('click', () => {
  if (selectedIds.size === games.length) {
    // Deselect all
    selectedIds.clear();
  } else {
    // Select all
    for (const g of games) selectedIds.add(g.titleId);
  }
  renderGameGrid();
  updateToolbarState();
});

// ==================== Processing ====================

btnProcess.addEventListener('click', async () => {
  if (selectedIds.size === 0) return;

  isProcessing = true;
  updateToolbarState();
  progressContainer.classList.remove('hidden');
  btnCancel.classList.remove('hidden');

  const titleIds = Array.from(selectedIds);

  try {
    const response = await window.api.processGames(titleIds);
    const results = response.results || response;

    // Update game statuses based on results
    for (const result of results) {
      const game = games.find((g) => g.titleId === result.titleId);
      if (game) {
        if (result.success && result.error) {
          // Partial success with warnings
          game.status = 'completed';
          game.errorMessage = result.error;
        } else {
          game.status = result.success ? 'completed' : 'error';
          game.errorMessage = result.error;
        }
      }
    }

    // If MTP target, show "open folder" prompt
    const hasSuccess = results.some(r => r.success);
    if (hasSuccess && response.outputDir) {
      const isMtp = response.isMtp;
      progressMessage.innerHTML = isMtp
        ? `游戏文件已提取到本地暂存文件夹，请手动复制到 Switch`
        : `处理完成`;
      progressMessage.innerHTML += ` <a href="#" id="btn-open-output" style="color:#e94560;text-decoration:underline;">打开文件夹</a>`;
      document.getElementById('btn-open-output').addEventListener('click', (e) => {
        e.preventDefault();
        window.api.openFolder(response.outputDir);
      });
    }
  } catch (err) {
    alert('处理失败: ' + err.message);
  }

  isProcessing = false;
  btnCancel.classList.add('hidden');
  renderGameGrid();
  updateToolbarState();
});

btnCancel.addEventListener('click', async () => {
  await window.api.cancelProcessing();
  btnCancel.classList.add('hidden');
});

// ==================== Progress Events ====================

window.api.onProgress((data) => {
  // Skip organizing progress — handled separately in organize panel
  if (data.stage === 'organizing') return;

  progressTitle.textContent = data.gameName || '';
  progressPercent.textContent = data.percent !== undefined ? `${data.percent}%` : '';
  progressFill.style.width = `${data.percent || 0}%`;
  progressMessage.textContent = data.message || '';

  // Update card status in real-time
  if (data.titleId) {
    const card = gameGrid.querySelector(`[data-title-id="${data.titleId}"]`);
    if (card) {
      card.className = 'game-card selected processing';
    }
  }
});

// ==================== Helpers ====================

function updateToolbarState() {
  btnSelectAll.disabled = games.length === 0 || isProcessing;
  btnProcess.disabled = selectedIds.size === 0 || isProcessing;
  btnScan.disabled = isProcessing;

  if (selectedIds.size === games.length && games.length > 0) {
    btnSelectAll.textContent = '取消全选';
  } else {
    btnSelectAll.textContent = '全选';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== Organize Folder ====================

const organizePanel = document.getElementById('organize-panel');
const btnOrganize = document.getElementById('btn-organize');
const btnCloseOrganize = document.getElementById('btn-close-organize');
const btnOrganizeExecute = document.getElementById('btn-organize-execute');
const btnOrganizeCancel = document.getElementById('btn-organize-cancel');
const organizeFolderSelect = document.getElementById('organize-folder-select');
const organizeSummary = document.getElementById('organize-summary');
const organizeActions = document.getElementById('organize-actions');
const organizeProgress = document.getElementById('organize-progress');
const organizeProgressTitle = document.getElementById('organize-progress-title');
const organizeProgressPercent = document.getElementById('organize-progress-percent');
const organizeProgressFill = document.getElementById('organize-progress-fill');
const organizeProgressMessage = document.getElementById('organize-progress-message');

let currentOrganizeActions = [];
let currentOrganizeFolder = '';

btnOrganize.addEventListener('click', async () => {
  currentSettings = await window.api.getSettings();
  const folders = currentSettings.sourceFolders || [];

  if (folders.length === 0) {
    alert('请先在设置中添加源文件夹');
    return;
  }

  // Populate folder dropdown
  organizeFolderSelect.innerHTML = '';
  for (const folder of folders) {
    const opt = document.createElement('option');
    opt.value = folder;
    opt.textContent = folder;
    organizeFolderSelect.appendChild(opt);
  }

  // Reset UI state
  organizeProgress.classList.add('hidden');
  btnOrganizeExecute.disabled = true;
  btnOrganizeExecute.textContent = '执行整理';
  organizeSummary.innerHTML = '';
  organizeActions.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">正在分析...</div>';
  currentOrganizeActions = [];

  organizePanel.classList.remove('hidden');

  // Analyze the first folder
  await analyzeSelectedFolder();
});

organizeFolderSelect.addEventListener('change', async () => {
  await analyzeSelectedFolder();
});

async function analyzeSelectedFolder() {
  const folder = organizeFolderSelect.value;
  if (!folder) return;

  currentOrganizeFolder = folder;
  btnOrganizeExecute.disabled = true;
  organizeSummary.innerHTML = '';
  organizeActions.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">正在分析...</div>';

  try {
    const result = await window.api.organizeAnalyze(folder);
    currentOrganizeActions = result.actions;
    renderOrganizeSummary(result.summary);
    renderOrganizeActions(result.actions);
    btnOrganizeExecute.disabled = result.actions.length === 0;
  } catch (err) {
    organizeActions.innerHTML = `<div style="text-align:center;color:var(--danger);padding:20px;">分析失败: ${escapeHtml(err.message)}</div>`;
  }
}

function renderOrganizeSummary(summary) {
  const items = [];
  if (summary.rename_folder > 0) items.push(`<span class="organize-summary-item"><span class="count">${summary.rename_folder}</span>重命名</span>`);
  if (summary.flatten_nested > 0) items.push(`<span class="organize-summary-item"><span class="count">${summary.flatten_nested}</span>嵌套整理</span>`);
  if (summary.move_zip > 0) items.push(`<span class="organize-summary-item"><span class="count">${summary.move_zip}</span>ZIP移入</span>`);
  if (summary.move_files > 0) items.push(`<span class="organize-summary-item"><span class="count">${summary.move_files}</span>游戏文件移入</span>`);
  if (summary.delete_junk > 0) items.push(`<span class="organize-summary-item"><span class="count">${summary.delete_junk}</span>垃圾清理</span>`);

  if (items.length === 0) {
    organizeSummary.innerHTML = '<span class="organize-summary-item">文件夹已整理完毕，无需操作</span>';
  } else {
    organizeSummary.innerHTML = items.join('');
  }
}

function getActionIcon(type) {
  const icons = {
    rename_folder: '📝',
    flatten_nested: '📂',
    move_zip: '📦',
    move_files: '🎮',
    delete_junk: '🗑️',
  };
  return icons[type] || '•';
}

function getActionTag(type) {
  const tags = {
    rename_folder: '<span class="action-tag tag-rename">重命名</span>',
    flatten_nested: '<span class="action-tag tag-flatten">嵌套</span>',
    move_zip: '<span class="action-tag tag-move">移入ZIP</span>',
    move_files: '<span class="action-tag tag-move">移入文件</span>',
    delete_junk: '<span class="action-tag tag-delete">清理</span>',
  };
  return tags[type] || '';
}

function renderOrganizeActions(actions) {
  if (actions.length === 0) {
    organizeActions.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">没有需要整理的操作</div>';
    return;
  }

  organizeActions.innerHTML = '';
  for (const action of actions) {
    const item = document.createElement('div');
    item.className = 'organize-action-item';
    item.innerHTML = `
      <span class="action-icon">${getActionIcon(action.type)}</span>
      ${getActionTag(action.type)}
      <span class="action-desc" title="${escapeHtml(action.description)}">${escapeHtml(action.description)}</span>
    `;
    organizeActions.appendChild(item);
  }
}

btnOrganizeExecute.addEventListener('click', async () => {
  if (currentOrganizeActions.length === 0) return;

  btnOrganizeExecute.disabled = true;
  btnOrganizeExecute.textContent = '执行中...';
  organizeFolderSelect.disabled = true;
  organizeProgress.classList.remove('hidden');
  organizeProgressFill.style.width = '0%';
  organizeProgressPercent.textContent = '';
  organizeProgressMessage.textContent = '';

  try {
    const result = await window.api.organizeExecute(currentOrganizeFolder, currentOrganizeActions);
    const successCount = result.results.filter(r => r.success).length;
    const errorCount = result.errors.length;

    organizeProgress.classList.add('hidden');

    if (errorCount === 0) {
      organizeActions.innerHTML = `<div class="organize-result success">整理完成！成功执行 ${successCount} 项操作</div>`;
    } else {
      let html = `<div class="organize-result has-errors">完成 ${successCount} 项，失败 ${errorCount} 项</div>`;
      for (const err of result.errors) {
        html += `<div class="organize-action-item" style="border-left:3px solid var(--danger);">
          <span class="action-desc">${escapeHtml(err.action.description)}: ${escapeHtml(err.error)}</span>
        </div>`;
      }
      organizeActions.innerHTML = html;
    }

    btnOrganizeExecute.textContent = '执行整理';
    btnOrganizeCancel.textContent = '关闭';
  } catch (err) {
    organizeProgress.classList.add('hidden');
    organizeActions.innerHTML = `<div class="organize-result has-errors">执行失败: ${escapeHtml(err.message)}</div>`;
    btnOrganizeExecute.disabled = false;
    btnOrganizeExecute.textContent = '执行整理';
  }

  organizeFolderSelect.disabled = false;
});

btnCloseOrganize.addEventListener('click', () => {
  organizePanel.classList.add('hidden');
});

btnOrganizeCancel.addEventListener('click', () => {
  organizePanel.classList.add('hidden');
});

organizePanel.addEventListener('click', (e) => {
  if (e.target === organizePanel) organizePanel.classList.add('hidden');
});

// Listen for organize progress updates
window.api.onProgress((data) => {
  if (data.stage === 'organizing') {
    organizeProgressPercent.textContent = data.percent !== undefined ? `${data.percent}%` : '';
    organizeProgressFill.style.width = `${data.percent || 0}%`;
    organizeProgressMessage.textContent = data.message || '';
  }
});

// ==================== Main Process Log Forwarding ====================

window.api.onMainLog((...args) => {
  console.log('%c[Main Process]', 'color: #e94560; font-weight: bold;', ...args);
});

// ==================== Init ====================

async function init() {
  currentSettings = await window.api.getSettings();

  // If no TitleDB, prompt user
  const dbStatus = await window.api.getTitleDBStatus();
  if (!dbStatus.loaded) {
    scanStatus.textContent = '提示: 请先在设置中更新游戏数据库';
  }
}

init();
