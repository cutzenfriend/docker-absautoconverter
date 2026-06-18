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
2. Detect any newly failed conversion tasks and increment their failure counter — items that reach `MAX_CONVERSION_FAILURES` are skipped in all future cycles
3. For each configured library (supports multiple, comma-separated), fetch multi-file audiobooks via the Audiobookshelf API
4. Start `.m4b` conversions for available slots — libraries are processed sequentially and share the slot pool; already-converting and failure-blocked items are skipped
5. Encoding uses the configured `BITRATE`, or when set to `"source"`, matches each item's original audio bitrate
6. Repeat on a cron schedule (default: every hour at minute 20)

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
| `TZ` | No | `Europe/Berlin` | Container timezone |

### Persistent failure tracking (optional)

If a book keeps failing (e.g. due to bad metadata), the app will skip it after `MAX_CONVERSION_FAILURES` attempts and log a warning. By default the failure count resets when the container restarts. To persist it across restarts, mount a volume and set `FAILURE_PERSIST_PATH`:

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

## Acknowledgements

* [audiobookshelf](https://github.com/advplyr/audiobookshelf)

## Built With

Built with the latest node container as base and 2 further node modules.

* [Node-Cron](https://www.npmjs.com/package//node-cron)
* [Axios](https://www.npmjs.com/package/axios)
