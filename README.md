<br/>
<p align="center">
  <h3 align="center"><a href="https://www.audiobookshelf.org" target="_blank">Audiobookshelf</a> - Autoconverter .m4b</h3>

  <p align="center">
    A Docker to automatically convert all your current and future Audiobooks within Audiobookshelf to the single file .m4b format.
Your need your own running instance of Audiobookshelf for this Docker to work!
(It must not run on the same host tho.)
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

1. Get all items from the specified library. Filtered so that only multifile Audiobooks get returned
2. Start the .m4b converting process for the specified amount of Audiobooks via API
3. Wait and repeat until no more Audiobooks to convert are available
4. Look every (hour) for new multifile books

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
      LIBRARY_ID: "YOUR AUDIOBOOKSHELF LIBRARY ID" #Please edit - mandatory
      MAX_PARALLEL_CONVERSIONS: 3 #Keep CPU power in mind. Too many conversion in parallel decrease performance on your host!
      #CRON_SETTING: #optional - default is: (20 * * * * ) - every hour at minute 20
      TOKEN: "YOUR AUDIOBOOKSHELF API TOKEN" #Please edit - mandatory
```

## Acknowledgements

* [audiobookshelf](https://github.com/advplyr/audiobookshelf)

## Built With

Built with the latest node container as base and 2 further node modules.

* [Node-Cron](https://www.npmjs.com/package//node-cron)
* [Axios](https://www.npmjs.com/package/axios)
