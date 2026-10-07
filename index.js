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
var EMBED_METADATA;
var BITRATE_CAP;
var CONVERSION_LOG_PATH;
var CONVERT_SINGLE_FILES;
var CONVERT_NON_M4B;
var RUN_ON_START;
var DO_NOT_MERGE_M4B;

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
if (['true', '1', 'yes'].includes(String(process.env.RUN_ON_START).toLowerCase())) {
  RUN_ON_START = true;
  log('RUN_ON_START is enabled');
} else {
  RUN_ON_START = false;
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
if (['true', '1', 'yes'].includes(String(process.env.EMBED_METADATA).toLowerCase())) {
  EMBED_METADATA = true;
  log('EMBED_METADATA is enabled: single-file books whose embedded tags differ from Audiobookshelf will get their metadata embedded (quick embed, no backup)');
} else {
  EMBED_METADATA = false;
}
if (['true', '1', 'yes'].includes(String(process.env.CONVERT_SINGLE_FILES).toLowerCase())) {
  if (BITRATE === 'source' && !BITRATE_CAP) {
    CONVERT_SINGLE_FILES = false;
    log('CONVERT_SINGLE_FILES has no effect with BITRATE=source and no BITRATE_CAP, disabling');
  } else {
    CONVERT_SINGLE_FILES = true;
    log('CONVERT_SINGLE_FILES is enabled: single-file books above the target bitrate will be re-encoded');
  }
} else {
  CONVERT_SINGLE_FILES = false;
}
if (['true', '1', 'yes'].includes(String(process.env.CONVERT_NON_M4B).toLowerCase())) {
  CONVERT_NON_M4B = true;
  log('CONVERT_NON_M4B is enabled: single-file books that are not m4b will be converted regardless of bitrate');
} else {
  CONVERT_NON_M4B = false;
}
if (['true', '1', 'yes'].includes(String(process.env.DO_NOT_MERGE_M4B).toLowerCase())) {
  DO_NOT_MERGE_M4B = true;
  log('DO_NOT_MERGE_M4B is enabled: multi-file books containing m4b files will be skipped');
} else {
  DO_NOT_MERGE_M4B = false;
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
      results.push({ id: obj.id, title: obj.media.metadata.title, updatedAt: obj.updatedAt || null, isFile: !!obj.isFile });
    }
    Object.values(obj).forEach(value => collectItems(value, results));
  }
  return results;
}

async function getItemDetails(itemId) {
  try {
    const response = await axios.get(`${DOMAIN}/api/items/${itemId}?expanded=1`, { headers });
    const audioFiles = response.data?.media?.audioFiles || [];
    return {
      updatedAt: response.data?.updatedAt || null,
      metadata: response.data?.media?.metadata || {},
      files: audioFiles.map(f => ({
        path: f.metadata?.path || f.metadata?.filename || null,
        codec: f.codec || null,
        bitrateKbps: f.bitRate ? Math.round(f.bitRate / 1000) : null,
        channels: f.channels || null,
        metaTags: f.metaTags || {},
      })),
    };
  } catch (error) {
    log('Warning: failed to fetch audio info for item ' + itemId + ': ' + error.message);
    return null;
  }
}

async function getItemAudioInfo(itemId) {
  const details = await getItemDetails(itemId);
  return details ? details.files : null;
}

// Mirrors getFFMetadataObject() in Audiobookshelf: the tags ABS writes when
// embedding metadata, keyed by the field its scanner reads them back into.
// ABS skips empty values instead of clearing the tag, so fields without a
// value in ABS are not compared either.
function getExpectedTags(metadata) {
  return {
    tagTitle: metadata.title,
    tagArtist: (metadata.authors || []).map(a => a.name).join(', '),
    tagAlbum: (metadata.title || '') + (metadata.subtitle ? `: ${metadata.subtitle}` : ''),
    tagComposer: (metadata.narrators || []).join(', '),
    tagGenre: (metadata.genres || []).join('; '),
    tagDate: metadata.publishedYear,
    tagGrouping: (metadata.series || []).map(s => s.name + (s.sequence ? ` #${s.sequence}` : '')).join('; '),
  };
}

const TAG_LABELS = {
  tagTitle: 'title',
  tagArtist: 'author',
  tagAlbum: 'album',
  tagComposer: 'narrator',
  tagGenre: 'genre',
  tagDate: 'year',
  tagGrouping: 'series',
};

// Returns the labels of all fields whose embedded tag differs from ABS
function getMetadataDifferences(metadata, metaTags) {
  const differences = [];
  for (const [tag, expected] of Object.entries(getExpectedTags(metadata))) {
    const want = expected == null ? '' : String(expected).trim();
    if (!want) continue;
    const have = metaTags[tag] == null ? '' : String(metaTags[tag]).trim();
    if (want !== have) differences.push(TAG_LABELS[tag]);
  }
  return differences;
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

// Single-file items already checked and found to need nothing, mapped to the
// item's updatedAt at that time. Avoids re-fetching them every cycle, while
// an item changed in ABS (e.g. edited metadata) gets checked again.
const checkedSingleFileItems = new Map();
// Limit expanded item fetches per cycle so large libraries are scanned
// gradually instead of hammering the server in one go
const SINGLE_FILE_CHECK_BUDGET = 100;
// ABS runs metadata embeds one at a time in its own queue; cap how many of
// ours wait there so the queue doesn't fill up with a whole library
const MAX_PENDING_EMBEDS = 10;
// Multi-file books skipped by DO_NOT_MERGE_M4B. Counted into the library
// fetch limit so they can't fill the fetch window and starve the books behind
// them, and not re-fetched or re-logged every cycle. Resets on restart.
const skippedM4bItems = new Set();

function writeConversionLog(entry) {
  try {
    fs.appendFileSync(CONVERSION_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (error) {
    log('Warning: failed to write conversion log to ' + CONVERSION_LOG_PATH + ': ' + error.message);
  }
}

function recordFailure(itemId, title, kind = 'Conversion') {
  const count = (failureCounts.get(itemId)?.count || 0) + 1;
  failureCounts.set(itemId, { title, count });
  if (count >= MAX_CONVERSION_FAILURES) {
    log(`WARNING: ${kind} failed for "${title}" (${count}/${MAX_CONVERSION_FAILURES}) — item will be skipped, fix metadata and restart to retry`);
  } else {
    log(`${kind} failed for "${title}" (${count}/${MAX_CONVERSION_FAILURES})`);
  }
  saveFailureCounts();
}

// Count a failed outcome check; give up after a few attempts so a broken
// item doesn't stay tracked forever
function retryOutcomeCheck(itemId, pending, what) {
  pending.checkAttempts = (pending.checkAttempts || 0) + 1;
  if (pending.checkAttempts >= 3) {
    log(`Warning: could not determine ${what} outcome for "${pending.title}", giving up`);
    pendingConversions.delete(itemId);
  }
}

// ABS doesn't re-read the tags after embedding, so the stored tags would still
// show the old values. Rescan the item first, then compare against ABS again.
async function checkEmbedOutcome(itemId, pending) {
  try {
    await axios.post(`${DOMAIN}/api/items/${itemId}/scan`, null, { headers });
  } catch (error) {
    log(`Warning: failed to rescan "${pending.title}" after metadata embed: ${error.message}`);
    retryOutcomeCheck(itemId, pending, 'metadata embed');
    return;
  }

  const details = await getItemDetails(itemId);
  if (details === null || details.files.length !== 1) {
    retryOutcomeCheck(itemId, pending, 'metadata embed');
    return;
  }

  const remaining = getMetadataDifferences(details.metadata, details.files[0].metaTags);
  if (remaining.length === 0) {
    log(`Metadata embedded: ${pending.title} (updated: ${pending.differences.join(', ')})`);
    checkedSingleFileItems.set(itemId, details.updatedAt);
    if (CONVERSION_LOG_PATH) {
      writeConversionLog({
        type: 'embed-metadata',
        title: pending.title,
        itemId,
        startedAt: pending.startedAt,
        finishedAt: new Date().toISOString(),
        updatedFields: pending.differences,
      });
    }
  } else {
    log(`Metadata embed for "${pending.title}" did not apply, still differs in: ${remaining.join(', ')}`);
    recordFailure(itemId, pending.title, 'Metadata embed');
  }
  pendingConversions.delete(itemId);
}

// ABS removes encode tasks from /api/tasks as soon as they end (success or
// failure), so the outcome cannot be read from the task list. Instead, once a
// task we started is no longer active, the item's file state tells the result:
// a successful encode replaces the audio files with a single m4b.
async function processPendingConversions(activeItemIds, embedBusyItemIds) {
  for (const [itemId, pending] of [...pendingConversions]) {
    if (pending.embed) {
      // Queued embeds are not in the task list yet, so check the queue too
      if (!embedBusyItemIds.has(itemId)) await checkEmbedOutcome(itemId, pending);
      continue;
    }
    if (activeItemIds.has(itemId)) continue; // still running

    const files = await getItemAudioInfo(itemId);
    if (files === null) {
      retryOutcomeCheck(itemId, pending, 'conversion');
      continue;
    }

    if (files.length === 0) {
      log(`Warning: "${pending.title}" has no audio files anymore, cannot determine conversion outcome`);
      pendingConversions.delete(itemId);
      continue;
    }

    let succeeded;
    if (pending.singleFile) {
      // A single-file conversion keeps one file either way, so the outcome
      // shows in the result itself: it must be an m4b at (or below) the
      // requested bitrate — an unchanged file means the encode failed
      const actualKbps = files[0].bitrateKbps || 0;
      const requestedKbps = parseInt(pending.requestedBitrate) || 0;
      const resultPath = (files[0].path || '').toLowerCase();
      const isM4b = resultPath === '' || resultPath.endsWith('.m4b');
      succeeded = files.length === 1 && isM4b && requestedKbps > 0 && actualKbps > 0 && actualKbps <= requestedKbps * 1.1;
    } else {
      succeeded = files.length === 1;
    }

    if (succeeded) {
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

      // The converted file is a new state, so let the next scan check it again
      if (pending.singleFile) checkedSingleFileItems.delete(itemId);

      if (CONVERSION_LOG_PATH) {
        writeConversionLog({
          type: 'encode',
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
    } else {
      recordFailure(itemId, pending.title);
    }
    pendingConversions.delete(itemId);
  }
}

// Process single-file books. Three independent opt-ins share this scan:
// CONVERT_SINGLE_FILES re-encodes books whose bitrate is more than 10% above
// the target (BITRATE_CAP if set, otherwise BITRATE); CONVERT_NON_M4B
// converts books that are not m4b regardless of bitrate; EMBED_METADATA
// embeds the ABS metadata into books that don't need a conversion but whose
// embedded tags differ. Encoding always uses min(source, target) so nothing
// gets upscaled. Conversions only use slots left over after the multi-file
// books; embeds don't take conversion slots. Returns the number of
// conversions and embeds started.
async function processSingleFileItems(slotsAvailable, activeItemIds, embedBusyItemIds) {
  const targetKbps = parseInt(BITRATE_CAP || BITRATE) || null;
  let checkBudget = SINGLE_FILE_CHECK_BUDGET;
  let started = 0;
  let embedsStarted = 0;
  let checkedThisCycle = 0;
  let embedsInFlight = [...pendingConversions.values()].filter(p => p.embed).length;
  const hasCapacity = () => slotsAvailable > 0 || (EMBED_METADATA && embedsInFlight < MAX_PENDING_EMBEDS);

  for (const libraryId of LIBRARY_IDS) {
    if (checkBudget <= 0 || !hasCapacity()) break;

    let page = 0;
    while (checkBudget > 0 && hasCapacity()) {
      // filter=tracks.c2luZ2xl is base64 for "single"
      const url = `${DOMAIN}/api/libraries/${libraryId}/items?limit=100&page=${page}&filter=tracks.c2luZ2xl`;
      let response;
      try {
        response = await axios.get(url, { headers });
      } catch (error) {
        log('Error fetching single-file items from library ' + libraryId + ': ' + error.message);
        break;
      }

      const items = collectItems(response.data);
      if (items.length === 0) break;

      for (const item of items) {
        if (checkBudget <= 0 || !hasCapacity()) break;
        if (checkedSingleFileItems.has(item.id) && checkedSingleFileItems.get(item.id) === item.updatedAt) continue;
        if (activeItemIds.has(item.id) || embedBusyItemIds.has(item.id) || pendingConversions.has(item.id)) continue;
        if ((failureCounts.get(item.id)?.count || 0) >= MAX_CONVERSION_FAILURES) {
          log(`Single-file skip: ${item.title} — too many failed attempts`);
          checkedSingleFileItems.set(item.id, item.updatedAt);
          continue;
        }

        checkBudget--;
        checkedThisCycle++;
        const details = await getItemDetails(item.id);
        if (details === null) continue; // fetch failed, retry next cycle
        const files = details.files;
        if (files.length !== 1) {
          log(`Single-file skip: ${item.title} — item no longer has exactly one audio file`);
          checkedSingleFileItems.set(item.id, item.updatedAt);
          continue;
        }

        const codec = files[0].codec || 'unknown codec';
        const sourceKbps = files[0].bitrateKbps || 0;
        const sourceText = sourceKbps > 0 ? sourceKbps + 'k' : 'unknown';
        const isM4b = (files[0].path || '').toLowerCase().endsWith('.m4b');

        const wantsFormat = CONVERT_NON_M4B && !isM4b;
        const wantsBitrate = CONVERT_SINGLE_FILES && targetKbps && sourceKbps > targetKbps * 1.1;
        if (wantsFormat || wantsBitrate) {
          if (slotsAvailable <= 0) continue; // no free slot, pick it up next cycle

          // min(source, target) so low-bitrate books never get upscaled; if the
          // source bitrate is unknown, fall back to the target (or 128k)
          const encodeKbps = sourceKbps > 0
            ? (targetKbps ? Math.min(sourceKbps, targetKbps) : sourceKbps)
            : (targetKbps || 128);
          const bitrate = encodeKbps + 'k';
          log(`Starting single-file conversion: ${item.title} (${codec} @ ${sourceText} -> m4b @ ${bitrate})`);
          try {
            const codecParam = CODEC ? `&codec=${CODEC}` : '';
            await axios.post(`${DOMAIN}/api/tools/item/${item.id}/encode-m4b?token=${TOKEN}&bitrate=${bitrate}${codecParam}`);
            pendingConversions.set(item.id, {
              title: item.title,
              startedAt: new Date().toISOString(),
              requestedBitrate: bitrate,
              before: summarizeAudioFiles(files),
              singleFile: true,
            });
            slotsAvailable--;
            started++;
          } catch (error) {
            log('Error starting re-encode for ' + item.title + ': ' + error.message);
          }
          continue;
        }

        const differences = EMBED_METADATA ? getMetadataDifferences(details.metadata, files[0].metaTags) : [];
        if (differences.length > 0) {
          if (item.isFile) {
            // ABS can't rescan items stored directly in the library folder,
            // so the embed could never be verified
            log(`Single-file skip: ${item.title} — metadata differs (${differences.join(', ')}) but the file is not in its own folder, so the embed can't be verified`);
            checkedSingleFileItems.set(item.id, item.updatedAt);
            continue;
          }
          if (embedsInFlight >= MAX_PENDING_EMBEDS) continue; // embed queue full, pick it up next cycle

          // backup=0 is ABS's "Quick Embed": tag the file in place without a backup copy
          log(`Starting metadata embed: ${item.title} (differs in: ${differences.join(', ')})`);
          try {
            await axios.post(`${DOMAIN}/api/tools/item/${item.id}/embed-metadata?backup=0`, null, { headers });
            pendingConversions.set(item.id, {
              title: item.title,
              startedAt: new Date().toISOString(),
              embed: true,
              differences,
            });
            embedsInFlight++;
            embedsStarted++;
          } catch (error) {
            log('Error starting metadata embed for ' + item.title + ': ' + error.message);
          }
          continue;
        }

        const reasons = [];
        if (CONVERT_NON_M4B && isM4b) reasons.push('already m4b');
        if (CONVERT_SINGLE_FILES && targetKbps) reasons.push(sourceKbps > 0 ? `within target ${targetKbps}k (+10% tolerance)` : 'bitrate unknown');
        if (EMBED_METADATA) reasons.push('embedded tags match Audiobookshelf');
        log(`Single-file skip: ${item.title} (${codec} @ ${sourceText}) — ${reasons.join(', ')}, nothing to do`);
        checkedSingleFileItems.set(item.id, item.updatedAt);
      }

      if (items.length < 100) break; // last page
      page++;
    }
  }

  // Books already checked in earlier cycles are cached and skipped silently,
  // so a quiet cycle after the initial scan is expected
  if (checkedThisCycle > 0 || started > 0 || embedsStarted > 0) {
    const embedText = EMBED_METADATA ? `, ${embedsStarted} metadata embed(s)` : '';
    log(`Single-file scan: checked ${checkedThisCycle} book(s) this cycle, started ${started} conversion(s)${embedText}`);
  }

  return { started, embedsStarted };
}

async function getActiveConversions() {
  try {
    // include=queue also returns embeds waiting in ABS's metadata queue,
    // which only show up as tasks once they start running
    const response = await axios.get(`${DOMAIN}/api/tasks?include=queue`, { headers });
    const tasks = response.data?.tasks || [];
    const isRunning = t => !t.isFinished && !t.isFailed;
    const active = tasks.filter(t => t.action && t.action.includes('encode-m4b') && isRunning(t));
    const activeItemIds = new Set(active.map(t => t.data?.libraryItemId).filter(Boolean));
    const embedBusyItemIds = new Set([
      ...tasks.filter(t => t.action === 'embed-metadata' && isRunning(t)).map(t => t.data?.libraryItemId),
      ...(response.data?.queuedTaskData?.embedMetadata || []).map(d => d.libraryItemId),
    ].filter(Boolean));
    return { count: active.length, activeItemIds, embedBusyItemIds };
  } catch (error) {
    log('Warning: failed to fetch tasks, falling back to full slot count: ' + error.message);
    return { count: -1, activeItemIds: new Set(), embedBusyItemIds: new Set() };
  }
}

async function start() {
  const { count: activeCount, activeItemIds, embedBusyItemIds } = await getActiveConversions();

  // Determine the outcome of conversions we started (skip if the task list
  // could not be fetched, since then "no longer active" is not reliable)
  if (activeCount >= 0) {
    await processPendingConversions(activeItemIds, embedBusyItemIds);
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

    const fetchLimit = slotsAvailable + activeItemIds.size + blockedCount + skippedM4bItems.size;
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
      if (skippedM4bItems.has(item.id)) continue;

      if (activeItemIds.has(item.id)) {
        log('Skipping (already converting): ' + item.title);
        continue;
      }

      if ((failureCounts.get(item.id)?.count || 0) >= MAX_CONVERSION_FAILURES) {
        log(`Skipping (too many failures): ${item.title}`);
        continue;
      }

      const sourceFiles = await getItemAudioInfo(item.id);
      if (DO_NOT_MERGE_M4B) {
        // Without the file list we can't rule out m4b parts, so don't risk a merge
        if (sourceFiles === null) continue;
        if (sourceFiles.some(file => file.path?.toLowerCase().endsWith('.m4b'))) {
          log(`Skipping (contains an m4b file): ${item.title}`);
          skippedM4bItems.add(item.id);
          continue;
        }
      }
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

  let embedsStarted = 0;
  if (((CONVERT_SINGLE_FILES || CONVERT_NON_M4B) && slotsAvailable > 0) || EMBED_METADATA) {
    const result = await processSingleFileItems(slotsAvailable, activeItemIds, embedBusyItemIds);
    slotsAvailable -= result.started;
    totalStarted += result.started;
    embedsStarted = result.embedsStarted;
  }

  const embedText = EMBED_METADATA ? `, ${embedsStarted} metadata embed(s)` : '';
  log(`Conversion cycle complete: ${totalStarted} conversion(s)${embedText} started`);
}

function scheduleCron() {
  cron.schedule(CRON_SETTING, () => {
    start().catch(error => {
      log('Unhandled error in start(): ' + error.message);
    });
  });
}

if (RUN_ON_START) {
  start()
    .catch(error => {
      log('Unhandled error in initial start(): ' + error.message);
    })
    .finally(scheduleCron);
} else {
  scheduleCron();
}
