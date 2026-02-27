const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');

// Use US.en as primary (33k+ entries), CN.zh as overlay for Chinese names
const DB_SOURCES = [
  { key: 'US.en', url: 'https://raw.githubusercontent.com/blawar/titledb/master/US.en.json' },
  { key: 'CN.zh', url: 'https://raw.githubusercontent.com/blawar/titledb/master/CN.zh.json' },
];

let titleMap = new Map(); // baseTitleId -> GameInfo
let dbLoaded = false;

function getDBDir() {
  return path.join(app.getPath('userData'), 'titledb');
}

function getDBPath(key) {
  return path.join(getDBDir(), `${key}.json`);
}

function download(url) {
  return new Promise((resolve, reject) => {
    const request = (targetUrl) => {
      https.get(targetUrl, { headers: { 'User-Agent': 'switch-game-manager' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      }).on('error', reject);
    };
    request(url);
  });
}

/**
 * Convert any Title ID to its base game Title ID.
 * Switch Title IDs: last 3 hex chars = 000 (base), 800 (update), 001-7FF (DLC).
 */
function toBaseTitleId(titleId) {
  if (!titleId || titleId.length < 16) return titleId;
  return titleId.slice(0, 13) + '000';
}

function buildMap(primaryJson, chineseJson) {
  titleMap.clear();

  // Load US.en as primary (most complete)
  for (const [, info] of Object.entries(primaryJson)) {
    const titleId = info.id || '';
    if (!titleId) continue;
    const baseId = toBaseTitleId(titleId.toUpperCase());
    titleMap.set(baseId, {
      name: info.name || '',
      iconUrl: info.iconUrl || '',
      publisher: info.publisher || '',
      id: baseId,
    });
  }

  // Overlay CN.zh for Chinese names where available
  if (chineseJson) {
    for (const [, info] of Object.entries(chineseJson)) {
      const titleId = info.id || '';
      if (!titleId) continue;
      const baseId = toBaseTitleId(titleId.toUpperCase());
      const existing = titleMap.get(baseId);
      if (existing && info.name) {
        existing.name = info.name; // Replace English name with Chinese
        if (info.publisher) existing.publisher = info.publisher;
      } else if (!existing && info.name) {
        titleMap.set(baseId, {
          name: info.name,
          iconUrl: info.iconUrl || '',
          publisher: info.publisher || '',
          id: baseId,
        });
      }
    }
  }

  dbLoaded = true;
}

async function loadDB() {
  const primaryPath = getDBPath('US.en');
  const chinesePath = getDBPath('CN.zh');

  let primaryJson = null;
  let chineseJson = null;

  if (fs.existsSync(primaryPath)) {
    try {
      primaryJson = JSON.parse(fs.readFileSync(primaryPath, 'utf-8'));
    } catch (e) {
      console.error('Failed to load US.en TitleDB:', e.message);
    }
  }

  if (fs.existsSync(chinesePath)) {
    try {
      chineseJson = JSON.parse(fs.readFileSync(chinesePath, 'utf-8'));
    } catch (e) {
      console.error('Failed to load CN.zh TitleDB:', e.message);
    }
  }

  if (primaryJson) {
    buildMap(primaryJson, chineseJson);
    return true;
  }
  return false;
}

async function updateDB(onProgress) {
  const dir = getDBDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let primaryJson = null;
  let chineseJson = null;

  for (const source of DB_SOURCES) {
    if (onProgress) onProgress(`正在下载 ${source.key}...`);
    const raw = await download(source.url);
    const json = JSON.parse(raw);
    fs.writeFileSync(getDBPath(source.key), raw, 'utf-8');

    if (source.key === 'US.en') primaryJson = json;
    if (source.key === 'CN.zh') chineseJson = json;
  }

  buildMap(primaryJson, chineseJson);
  return titleMap.size;
}

function lookupTitle(titleId) {
  if (!dbLoaded) return null;
  const normalized = titleId.toUpperCase();
  // Try exact match first, then try base Title ID
  return titleMap.get(normalized) || titleMap.get(toBaseTitleId(normalized)) || null;
}

function getStatus() {
  const primaryPath = getDBPath('US.en');
  const exists = fs.existsSync(primaryPath);
  let lastModified = null;
  if (exists) {
    const stat = fs.statSync(primaryPath);
    lastModified = stat.mtime.toISOString();
  }
  return { loaded: dbLoaded, exists, lastModified, entryCount: titleMap.size };
}

module.exports = { loadDB, updateDB, lookupTitle, getStatus, toBaseTitleId };
