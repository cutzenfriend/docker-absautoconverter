const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

function log(message) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  console.log(`[${timestamp}] ${message}`);
}

var DOMAIN;
var LIBRARY_IDS;
var MAX_PARALLEL_CONVERSIONS;
var CRON_SETTING;
var TOKEN;
var BITRATE;
var MAX_CONVERSION_FAILURES;
var FAILURE_PERSIST_PATH;
var CODEC;
var BITRATE_CAP;

if (process.env.TZ) {
  log('Timezone is set to: ' + process.env.TZ);
} else {
  process.env.TZ = 'Europe/Berlin';
}
if (process.env.DOMAIN) {
  log('DOMAIN is set to: ' + process.env.DOMAIN);
  DOMAIN = process.env.DOMAIN;
} else {
  log('DOMAIN is mandatory, exiting');
  process.exit();
}
if (process.env.LIBRARY_ID) {
  LIBRARY_IDS = process.env.LIBRARY_ID.split(',').map(s => s.trim());
  log('LIBRARY_IDS is set to: ' + LIBRARY_IDS.join(', '));
} else {
  log('LIBRARY_ID is mandatory, exiting');
  process.exit();
}
if (process.env.MAX_PARALLEL_CONVERSIONS) {
  MAX_PARALLEL_CONVERSIONS = parseInt(process.env.MAX_PARALLEL_CONVERSIONS);
  log('MAX_PARALLEL_CONVERSIONS is set to: ' + MAX_PARALLEL_CONVERSIONS);
} else {
  MAX_PARALLEL_CONVERSIONS = 5;
  log('MAX_PARALLEL_CONVERSIONS set to default 5');
}
if (process.env.CRON_SETTING) {
  log('CRON_SETTING is set to: ' + process.env.CRON_SETTING);
  CRON_SETTING = process.env.CRON_SETTING;
} else {
  CRON_SETTING = '20 * * * *';
  log('CRON_SETTING set to default (20 * * * *)');
}
if (process.env.TOKEN) {
  log('TOKEN is set');
  TOKEN = process.env.TOKEN;
} else {
  log('TOKEN is mandatory, exiting');
  process.exit();
}
if (process.env.BITRATE) {
  BITRATE = process.env.BITRATE;
  if (BITRATE === 'source') {
    log('BITRATE mode: source (will match each item\'s original bitrate)');
  } else {
    log('BITRATE is set to: ' + BITRATE);
  }
} else {
  BITRATE = '128k';
  log('BITRATE set to default 128k');
}
if (process.env.CODEC) {
  CODEC = process.env.CODEC;
  log('CODEC is set to: ' + CODEC);
} else {
  CODEC = null;
  log('CODEC not set, using Audiobookshelf default (aac)');
}
if (process.env.BITRATE_CAP) {
  BITRATE_CAP = process.env.BITRATE_CAP;
  log('BITRATE_CAP is set to: ' + BITRATE_CAP + ' (will use lower of source bitrate and cap)');
} else {
  BITRATE_CAP = null;
}
if (process.env.MAX_CONVERSION_FAILURES) {
  MAX_CONVERSION_FAILURES = parseInt(process.env.MAX_CONVERSION_FAILURES);
  log('MAX_CONVERSION_FAILURES is set to: ' + MAX_CONVERSION_FAILURES);
} else {
  MAX_CONVERSION_FAILURES = 3;
  log('MAX_CONVERSION_FAILURES set to default 3');
}
if (process.env.FAILURE_PERSIST_PATH) {
  FAILURE_PERSIST_PATH = process.env.FAILURE_PERSIST_PATH;
  log('FAILURE_PERSIST_PATH is set to: ' + FAILURE_PERSIST_PATH);
} else {
  FAILURE_PERSIST_PATH = null;
  log('FAILURE_PERSIST_PATH not set, failure counts will reset on container restart');
}

const headers = { Authorization: 'Bearer ' + TOKEN };

const failureCounts = new Map();
const countedFailedTaskIds = new Set();

function loadFailureCounts() {
  if (!FAILURE_PERSIST_PATH) return;
  try {
    if (fs.existsSync(FAILURE_PERSIST_PATH)) {
      const data = JSON.parse(fs.readFileSync(FAILURE_PERSIST_PATH, 'utf8'));
      for (const [itemId, count] of Object.entries(data)) {
        failureCounts.set(itemId, count);
      }
      log(`Loaded failure counts for ${failureCounts.size} item(s) from ${FAILURE_PERSIST_PATH}`);
    }
  } catch (error) {
    log('Warning: failed to load failure counts from ' + FAILURE_PERSIST_PATH + ': ' + error.message);
  }
}

function saveFailureCounts() {
  if (!FAILURE_PERSIST_PATH) return;
  try {
    const data = Object.fromEntries(failureCounts);
    fs.writeFileSync(FAILURE_PERSIST_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    log('Warning: failed to save failure counts to ' + FAILURE_PERSIST_PATH + ': ' + error.message);
  }
}

loadFailureCounts();

function collectItems(obj, results = []) {
  if (Array.isArray(obj)) {
    obj.forEach(item => collectItems(item, results));
  } else if (obj && typeof obj === 'object') {
    if (obj.id && obj.media?.metadata?.title) {
      results.push({ id: obj.id, title: obj.media.metadata.title });
    }
    Object.values(obj).forEach(value => collectItems(value, results));
  }
  return results;
}

async function getSourceBitrate(itemId) {
  try {
    const response = await axios.get(`${DOMAIN}/api/items/${itemId}?expanded=1`, { headers });
    const audioFiles = response.data?.media?.audioFiles || [];
    if (audioFiles.length === 0) return null;
    const maxBitRate = Math.max(...audioFiles.map(f => f.bitRate || 0));
    if (maxBitRate === 0) return null;
    return Math.round(maxBitRate / 1000) + 'k';
  } catch (error) {
    log('Warning: failed to fetch source bitrate for item ' + itemId + ': ' + error.message);
    return null;
  }
}

async function getActiveConversions() {
  try {
    const response = await axios.get(`${DOMAIN}/api/tasks`, { headers });
    const tasks = response.data?.tasks || [];
    const encodeTasks = tasks.filter(t => t.action && t.action.includes('encode-m4b'));
    const active = encodeTasks.filter(t => !t.isFinished && !t.isFailed);
    const activeItemIds = new Set(active.map(t => t.data?.libraryItemId).filter(Boolean));
    const newlyFailed = encodeTasks
      .filter(t => t.isFailed && t.id && !countedFailedTaskIds.has(t.id) && t.data?.libraryItemId)
      .map(t => ({ taskId: t.id, itemId: t.data.libraryItemId }));
    return { count: active.length, activeItemIds, newlyFailed };
  } catch (error) {
    log('Warning: failed to fetch tasks, falling back to full slot count: ' + error.message);
    return { count: -1, activeItemIds: new Set(), newlyFailed: [] };
  }
}

async function start() {
  const { count: activeCount, activeItemIds, newlyFailed } = await getActiveConversions();

  // Process newly failed tasks and update failure counts
  for (const { taskId, itemId } of newlyFailed) {
    countedFailedTaskIds.add(taskId);
    const count = (failureCounts.get(itemId) || 0) + 1;
    failureCounts.set(itemId, count);
    if (count >= MAX_CONVERSION_FAILURES) {
      log(`WARNING: Item ${itemId} has failed ${count} time(s) and will be skipped — fix metadata and restart to retry`);
    } else {
      log(`Item ${itemId} has failed ${count}/${MAX_CONVERSION_FAILURES} time(s)`);
    }
  }
  if (newlyFailed.length > 0) saveFailureCounts();

  let slotsAvailable;
  if (activeCount < 0) {
    slotsAvailable = MAX_PARALLEL_CONVERSIONS;
  } else {
    slotsAvailable = MAX_PARALLEL_CONVERSIONS - activeCount;
    log(`Active conversions: ${activeCount}, available slots: ${slotsAvailable}`);
  }
  if (slotsAvailable <= 0) {
    log('No available conversion slots, skipping this cycle');
    return;
  }

  const blockedCount = [...failureCounts.values()].filter(n => n >= MAX_CONVERSION_FAILURES).length;
  let totalStarted = 0;

  for (const libraryId of LIBRARY_IDS) {
    if (slotsAvailable <= 0) break;

    const fetchLimit = slotsAvailable + activeItemIds.size + blockedCount;
    const url = `${DOMAIN}/api/libraries/${libraryId}/items?limit=${fetchLimit}&page=0&filter=tracks.bXVsdGk%3D`;

    let response;
    try {
      response = await axios.get(url, { headers });
    } catch (error) {
      log('Error fetching library ' + libraryId + ': ' + error.message);
      continue;
    }

    const items = collectItems(response.data);
    if (items.length === 0) {
      log('No multi-file audiobooks found in library ' + libraryId);
      continue;
    }

    log('Found ' + items.length + ' multi-file audiobook(s) in library ' + libraryId);

    for (const item of items) {
      if (slotsAvailable <= 0) break;

      if (activeItemIds.has(item.id)) {
        log('Skipping (already converting): ' + item.title);
        continue;
      }

      if ((failureCounts.get(item.id) || 0) >= MAX_CONVERSION_FAILURES) {
        log(`Skipping (too many failures): ${item.title}`);
        continue;
      }

      let bitrate = BITRATE;
      if (BITRATE_CAP) {
        const sourceBitrate = await getSourceBitrate(item.id);
        if (sourceBitrate) {
          const sourceKbps = parseInt(sourceBitrate);
          const capKbps = parseInt(BITRATE_CAP);
          bitrate = Math.min(sourceKbps, capKbps) + 'k';
          log(`Using ${bitrate} for: ${item.title} (source: ${sourceBitrate}, cap: ${BITRATE_CAP})`);
        } else {
          bitrate = BITRATE_CAP;
          log(`Could not determine source bitrate for: ${item.title}, falling back to cap ${BITRATE_CAP}`);
        }
      } else if (BITRATE === 'source') {
        const sourceBitrate = await getSourceBitrate(item.id);
        if (sourceBitrate) {
          bitrate = sourceBitrate;
          log(`Using source bitrate ${bitrate} for: ${item.title}`);
        } else {
          bitrate = '128k';
          log(`Could not determine source bitrate for: ${item.title}, falling back to 128k`);
        }
      }

      log('Starting conversion: ' + item.title);
      try {
        const codecParam = CODEC ? `&codec=${CODEC}` : '';
        await axios.post(`${DOMAIN}/api/tools/item/${item.id}/encode-m4b?token=${TOKEN}&bitrate=${bitrate}${codecParam}`);
      } catch (error) {
        log('Error starting conversion for ' + item.title + ': ' + error.message);
      }

      slotsAvailable--;
      totalStarted++;
    }
  }

  log(`Conversion cycle complete: ${totalStarted} conversion(s) started`);
}

// CRON START
cron.schedule(CRON_SETTING, () => {
  start().catch(error => {
    log('Unhandled error in start(): ' + error.message);
  });
});
