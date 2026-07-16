<br/>
<p align="center">
  <h3 align="center"><a href="https://www.audiobookshelf.org" target="_blank">Audiobookshelf</a> - Autoconverter .m4b</h3>

  <p align="center">
    A Docker to automatically convert all your current and future Audiobooks within Audiobookshelf to the single file .m4b format.
Your need (of cause) a running instance of Audiobookshelf for this Docker to work with!
(It can run on a different host than audiobookshelf if necessary)
    <br/>
    <br/>
  </p>
</p>

## About The Project

I had a huge library of Audiobooks. Some of them were already .m4b but most of them were multiple mp3's.

I wanted to archive 3 things:
1. Convert all my mp3 only Audiobooks to .m4b but a maximum of X in parallel (to not stress the server CPU too much).
2. Automatic convert of newly added Audiobooks if they are not single file .m4b and let it check in cron style within a container.
3. Don't use 3rd party software and use the built in converter of Audiobookshelf instead. So the API of Audiobookshelf was the way to go.

https://hub.docker.com/r/cutzenfriend/abs-autoconverter

## How it works

1. Check for active `.m4b` conversion tasks on the server and calculate available slots (`MAX_PARALLEL_CONVERSIONS` minus active conversions)
2. Determine the outcome of conversions started in earlier cycles: Audiobookshelf removes encode tasks from its task list as soon as they end, so the outcome is detected by checking the item's files — a single `.m4b` means success, still multiple files means the conversion failed
3. Successful conversions are logged with a before/after summary (and optionally appended to a persistent log file via `CONVERSION_LOG_PATH`); failed ones increment the item's failure counter, and items that reach `MAX_CONVERSION_FAILURES` are skipped in all future cycles
4. For each configured library (supports multiple, comma-separated), fetch multi-file audiobooks via the Audiobookshelf API
5. Start `.m4b` conversions for available slots — libraries are processed sequentially and share the slot pool; already-converting and failure-blocked items are skipped
6. Encoding uses the configured `BITRATE`, or when set to `"source"`, matches each item's original audio bitrate
7. Repeat on a cron schedule (default: every hour at minute 20)

## Getting Started

The easiest way is to use the docker-compose.yml in this repository. 

### Prerequisites

Before running the container please adapt the mandatory environment variables within the docker-compose.yml:

```sh
version: '3.3'
services:
  abs-autoconverter:
    image: cutzenfriend/abs-autoconverter:latest
    container_name: abs-autoconverter
    restart: unless-stopped
    environment:
      TZ: "Europe/Berlin"
      DOMAIN: "https://abs.example.com" #Please edit - mandatory
      LIBRARY_ID: "lib1-id,lib2-id" #Please edit - mandatory, comma-separated for multiple libraries
      MAX_PARALLEL_CONVERSIONS: 3 #Keep CPU power in mind. Too many conversion in parallel decrease performance on your host!
      #CRON_SETTING: #optional - default is: (20 * * * * ) - every hour at minute 20
      BITRATE: "128k" #optional - default is 128k, set to "source" to match each item's original bitrate
      TOKEN: "YOUR AUDIOBOOKSHELF API TOKEN" #Please edit - mandatory
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DOMAIN` | Yes | — | Audiobookshelf server URL (e.g. `https://abs.example.com`) |
| `LIBRARY_ID` | Yes | — | Audiobookshelf library ID(s). Comma-separated for multiple libraries (e.g. `lib1-id,lib2-id`) |
| `TOKEN` | Yes | — | Audiobookshelf API token |
| `MAX_PARALLEL_CONVERSIONS` | No | `5` | Maximum concurrent conversions. Active tasks are checked before each cycle so this limit is respected across runs |
| `CRON_SETTING` | No | `20 * * * *` | Cron expression for the check interval |
| `BITRATE` | No | `128k` | M4B encoding bitrate. Set to `"source"` to match each item's original audio bitrate |
| `BITRATE_CAP` | No | — | When set, uses the lower of the item's source bitrate and this cap (e.g. `120k`). Prevents upscaling low-bitrate books while still normalizing high-bitrate ones. Overrides `BITRATE` when set |
| `CODEC` | No | `aac` | Audio codec for encoding (e.g. `aac`, `opus`, `mp3`). Uses Audiobookshelf's default (`aac`) if not set |
| `MAX_CONVERSION_FAILURES` | No | `3` | Number of failed conversion attempts before an item is permanently skipped. Reset by restarting the container (or persisted via `FAILURE_PERSIST_PATH`) |
| `FAILURE_PERSIST_PATH` | No | — | Path to a JSON file for persisting failure counts across container restarts (e.g. `/data/failures.json`). Requires a volume mount |
| `CONVERSION_LOG_PATH` | No | — | Path to a persistent conversion log file (e.g. `/data/conversions.log`). One JSON line per completed conversion with before/after file path, codec, bitrate and channels. Requires a volume mount |
| `TZ` | No | `Europe/Berlin` | Container timezone |

### Persistent failure tracking (optional)

If a book keeps failing (e.g. due to bad metadata), the app will skip it after `MAX_CONVERSION_FAILURES` attempts and log a warning. Failures are detected by checking the item's files after its encode task ends — if the book still has multiple audio files, the conversion did not succeed. Only conversions started by this app are tracked; if the app restarts while a conversion is running, that attempt's outcome is not counted. By default the failure count resets when the container restarts. To persist it across restarts, mount a volume and set `FAILURE_PERSIST_PATH`:

```yaml
services:
  abs-autoconverter:
    ...
    environment:
      FAILURE_PERSIST_PATH: "/data/failures.json"
    volumes:
      - ./data:/data
```

To retry a skipped book, fix its metadata in Audiobookshelf and delete its entry from the JSON file (or delete the file entirely), then restart the container.

### Conversion log (optional)

To keep a persistent record of what was converted (useful when the container log is hard to access or not persisted, e.g. in Portainer), mount a volume and set `CONVERSION_LOG_PATH`:

```yaml
services:
  abs-autoconverter:
    ...
    environment:
      CONVERSION_LOG_PATH: "/data/conversions.log"
    volumes:
      - ./data:/data
```

Each completed conversion appends one JSON line with everything for that title in one place:

```json
{"title":"My Audiobook","itemId":"li_abc123","startedAt":"2026-07-13T10:20:00.000Z","finishedAt":"2026-07-13T11:20:00.000Z","requestedBitrate":"64k","before":{"fileCount":12,"path":"/audiobooks/Author/My Audiobook","codec":"mp3","bitrate":"128k","channels":2},"after":{"fileCount":1,"path":"/audiobooks/Author/My Audiobook/My Audiobook.m4b","codec":"aac","bitrate":"64k","channels":2}}
```

For multi-file sources, `before.path` is the containing folder and `before.bitrate` the highest bitrate among the source files. A completion summary is also written to the container log regardless of whether `CONVERSION_LOG_PATH` is set.

Each entry also includes `bitrateMatched`: whether the resulting bitrate is within 10% of the requested one (encoders never hit the target exactly). If it is not, a warning is written to the container log as well.

Note: completion is detected on the next cron cycle after the encode task finishes. If the app itself restarts while a conversion is running, that conversion will be missing from the log (tracking is in-memory).

## Acknowledgements

* [audiobookshelf](https://github.com/advplyr/audiobookshelf)

## Built With

Built with the latest node container as base and 2 further node modules.

* [Node-Cron](https://www.npmjs.com/package//node-cron)
* [Axios](https://www.npmjs.com/package/axios)
