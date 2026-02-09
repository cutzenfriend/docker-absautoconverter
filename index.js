const axios = require('axios');
const cron = require('node-cron');

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

const headers = { Authorization: 'Bearer ' + TOKEN };

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

async function getActiveConversionCount() {
  try {
    const response = await axios.get(`${DOMAIN}/api/tasks`, { headers });
    const tasks = response.data?.tasks || [];
    const active = tasks.filter(t =>
      t.action && t.action.includes('encode-m4b') && !t.isFinished && !t.isFailed
    );
    return active.length;
  } catch (error) {
    log('Warning: failed to fetch tasks, falling back to full slot count: ' + error.message);
    return -1;
  }
}

async function start() {
  const activeCount = await getActiveConversionCount();
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

  let totalStarted = 0;

  for (const libraryId of LIBRARY_IDS) {
    if (slotsAvailable <= 0) break;

    const url = `${DOMAIN}/api/libraries/${libraryId}/items?limit=${slotsAvailable}&page=0&filter=tracks.bXVsdGk%3D`;

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

      let bitrate = BITRATE;
      if (BITRATE === 'source') {
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
        await axios.post(`${DOMAIN}/api/tools/item/${item.id}/encode-m4b?token=${TOKEN}&bitrate=${bitrate}`);
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
