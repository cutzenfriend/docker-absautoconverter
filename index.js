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
var CONVERSION_LOG_PATH;

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
if (process.env.CONVERSION_LOG_PATH) {
  CONVERSION_LOG_PATH = process.env.CONVERSION_LOG_PATH;
  log('CONVERSION_LOG_PATH is set to: ' + CONVERSION_LOG_PATH);
} else {
  CONVERSION_LOG_PATH = null;
  log('CONVERSION_LOG_PATH not set, conversion results will only appear in the container log');
}

const headers = { Authorization: 'Bearer ' + TOKEN };

const failureCounts = new Map();

function loadFailureCounts() {
  if (!FAILURE_PERSIST_PATH) return;
  try {
    if (fs.existsSync(FAILURE_PERSIST_PATH)) {
      const data = JSON.parse(fs.readFileSync(FAILURE_PERSIST_PATH, 'utf8'));
      for (const [itemId, value] of Object.entries(data)) {
        // Files written before v1.6.3 stored a plain number instead of { title, count }
        failureCounts.set(itemId, typeof value === 'number' ? { title: null, count: value } : value);
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

async function getItemAudioInfo(itemId) {
  try {
    const response = await axios.get(`${DOMAIN}/api/items/${itemId}?expanded=1`, { headers });
    const audioFiles = response.data?.media?.audioFiles || [];
    return audioFiles.map(f => ({
      path: f.metadata?.path || f.metadata?.filename || null,
      codec: f.codec || null,
      bitrateKbps: f.bitRate ? Math.round(f.bitRate / 1000) : null,
      channels: f.channels || null,
    }));
  } catch (error) {
    log('Warning: failed to fetch audio info for item ' + itemId + ': ' + error.message);
    return null;
  }
}

function summarizeAudioFiles(files) {
  if (!files || files.length === 0) return null;
  const first = files[0];
  const maxKbps = Math.max(...files.map(f => f.bitrateKbps || 0));
  return {
    fileCount: files.length,
    // For multi-file books log the containing folder, for single files the full path
    path: files.length === 1 ? first.path : (first.path ? first.path.substring(0, first.path.lastIndexOf('/')) : null),
    codec: first.codec,
    bitrate: maxKbps > 0 ? maxKbps + 'k' : null,
    channels: first.channels,
  };
}

function sourceBitrateOf(files) {
  if (!files || files.length === 0) return null;
  const maxKbps = Math.max(...files.map(f => f.bitrateKbps || 0));
  return maxKbps > 0 ? maxKbps + 'k' : null;
}

const pendingConversions = new Map();

function writeConversionLog(entry) {
  try {
    fs.appendFileSync(CONVERSION_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (error) {
    log('Warning: failed to write conversion log to ' + CONVERSION_LOG_PATH + ': ' + error.message);
  }
}

function recordFailure(itemId, title) {
  const count = (failureCounts.get(itemId)?.count || 0) + 1;
  failureCounts.set(itemId, { title, count });
  if (count >= MAX_CONVERSION_FAILURES) {
    log(`WARNING: Conversion failed for "${title}" (${count}/${MAX_CONVERSION_FAILURES}) — item will be skipped, fix metadata and restart to retry`);
  } else {
    log(`Conversion failed for "${title}" (${count}/${MAX_CONVERSION_FAILURES})`);
  }
  saveFailureCounts();
}

// ABS removes encode tasks from /api/tasks as soon as they end (success or
// failure), so the outcome cannot be read from the task list. Instead, once a
// task we started is no longer active, the item's file state tells the result:
// a successful encode replaces the audio files with a single m4b.
async function processPendingConversions(activeItemIds) {
  for (const [itemId, pending] of [...pendingConversions]) {
    if (activeItemIds.has(itemId)) continue; // still running

    const files = await getItemAudioInfo(itemId);
    if (files === null) {
      pending.checkAttempts = (pending.checkAttempts || 0) + 1;
      if (pending.checkAttempts >= 3) {
        log(`Warning: could not determine conversion outcome for "${pending.title}", giving up`);
        pendingConversions.delete(itemId);
      }
      continue;
    }

    if (files.length === 1) {
      const after = summarizeAudioFiles(files);
      const before = pending.before;
      const beforeText = before ? `${before.fileCount} file(s), ${before.codec || '?'} @ ${before.bitrate || '?'}` : 'unknown source';
      log(`Conversion completed: ${pending.title} (${beforeText} -> ${after.codec || '?'} @ ${after.bitrate || '?'})`);

      // Verify the result matches the requested bitrate. Encoders never hit
      // the target exactly, so allow 10% (at least 8 kbps) deviation.
      let bitrateMatched = null;
      const requestedKbps = parseInt(pending.requestedBitrate);
      const actualKbps = after.bitrate ? parseInt(after.bitrate) : null;
      if (requestedKbps && actualKbps) {
        bitrateMatched = Math.abs(actualKbps - requestedKbps) <= Math.max(requestedKbps * 0.1, 8);
        if (!bitrateMatched) {
          log(`WARNING: "${pending.title}" was encoded at ${after.bitrate} but ${pending.requestedBitrate} was requested`);
        }
      }

      if (CONVERSION_LOG_PATH) {
        writeConversionLog({
          title: pending.title,
          itemId,
          startedAt: pending.startedAt,
          finishedAt: new Date().toISOString(),
          requestedBitrate: pending.requestedBitrate,
          bitrateMatched,
          before,
          after,
        });
      }
    } else if (files.length > 1) {
      recordFailure(itemId, pending.title);
    } else {
      log(`Warning: "${pending.title}" has no audio files anymore, cannot determine conversion outcome`);
    }
    pendingConversions.delete(itemId);
  }
}

async function getActiveConversions() {
  try {
    const response = await axios.get(`${DOMAIN}/api/tasks`, { headers });
    const tasks = response.data?.tasks || [];
    const encodeTasks = tasks.filter(t => t.action && t.action.includes('encode-m4b'));
    const active = encodeTasks.filter(t => !t.isFinished && !t.isFailed);
    const activeItemIds = new Set(active.map(t => t.data?.libraryItemId).filter(Boolean));
    return { count: active.length, activeItemIds };
  } catch (error) {
    log('Warning: failed to fetch tasks, falling back to full slot count: ' + error.message);
    return { count: -1, activeItemIds: new Set() };
  }
}

async function start() {
  const { count: activeCount, activeItemIds } = await getActiveConversions();

  // Determine the outcome of conversions we started (skip if the task list
  // could not be fetched, since then "no longer active" is not reliable)
  if (activeCount >= 0) {
    await processPendingConversions(activeItemIds);
  }

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

  const blockedCount = [...failureCounts.values()].filter(f => f.count >= MAX_CONVERSION_FAILURES).length;
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

      if ((failureCounts.get(item.id)?.count || 0) >= MAX_CONVERSION_FAILURES) {
        log(`Skipping (too many failures): ${item.title}`);
        continue;
      }

      const sourceFiles = await getItemAudioInfo(item.id);
      const sourceBitrate = sourceBitrateOf(sourceFiles);

      let bitrate = BITRATE;
      if (BITRATE_CAP) {
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
        pendingConversions.set(item.id, {
          title: item.title,
          startedAt: new Date().toISOString(),
          requestedBitrate: bitrate,
          before: summarizeAudioFiles(sourceFiles),
        });
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
