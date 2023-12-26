const axios = require('axios');
const cron = require('node-cron');

var MAX_PARALLEL_CONVERSIONS;
var DOMAIN;
var LIBRARY_ID;
var CRON_SETTING;
var TOKEN;

if(process.env.TZ) { 
  console.log('Timezone is set to: ' + process.env.TZ); 
} else { 
  process.env.TZ = "Europe/Berlin";
}
if(process.env.DOMAIN) { 
  console.log('DOMAIN is set to: ' + process.env.DOMAIN);
  DOMAIN = process.env.DOMAIN;
} else { 
  console.log('DOMAIN is mandatory exiting');
  process.exit();
}
if(process.env.LIBRARY_ID) { 
  console.log('LIBRARY_ID is set to: ' + process.env.LIBRARY_ID); 
  LIBRARY_ID = process.env.LIBRARY_ID;
} else { 
  console.log('LIBRARY_ID is mandatory exiting');
  process.exit();
}
if(process.env.MAX_PARALLEL_CONVERSIONS) { 
  console.log('MAX_PARALLEL_CONVERSIONS is set to: ' + process.env.MAX_PARALLEL_CONVERSIONS); 
  MAX_PARALLEL_CONVERSIONS = process.env.MAX_PARALLEL_CONVERSIONS;
} else { 
  MAX_PARALLEL_CONVERSIONS = 5;
  console.log('MAX_PARALLEL_CONVERSIONS set to default 5'); 
}
if(process.env.CRON_SETTING) { 
  console.log('CRON_SETTING is set to: ' + process.env.CRON_SETTING);
  CRON_SETTING = process.env.CRON_SETTING;
} else { 
  CRON_SETTING = '20 * * * *';
  console.log('CRON_SETTING set to default (20 * * * *)'); 
}
if(process.env.TOKEN) { 
  console.log('TOKEN is set to: ' + process.env.TOKEN); 
  TOKEN = process.env.TOKEN;
} else { 
  console.log('TOKEN is mandatory exiting');
  process.exit();
}
const url = DOMAIN + '/api/libraries/' + LIBRARY_ID + '/items?limit=' + MAX_PARALLEL_CONVERSIONS + '&page=0&filter=tracks.bXVsdGk%3D';
const headers = { Authorization: 'Bearer ' + TOKEN };
function extractItems(obj, results = []) {
    if (Array.isArray(obj)) {
        obj.forEach(item => extractItems(item, results));
    } else if (obj && typeof obj === 'object') {
        if (obj.id && obj.media?.metadata?.title) {
            results.push(`ID: ${obj.id}, Titel: ${obj.media.metadata.title}`);
            console.log("ID: " + obj.id + " Name: " + obj.media.metadata.title);
            axios.post(`${DOMAIN}/api/tools/item/${obj.id}/encode-m4b?token=${TOKEN}`)
            .then(response2 => {
            })
            .catch(error2 => {
              console.error('Fehler beim konvertieren:', error2);
            });
        }
        Object.values(obj).forEach(value => extractItems(value, results));
    }
    return results;
}
function start() {
  axios.get(url, { headers })
    .then(response => {
      var d = new Date();
      console.log(d.toLocaleString() + ' | Running next conversion | Converting the following Audiobooks to m4b:')      
      const data = response.data;
      const results = extractItems(data);
    })
    .catch(error => {
      console.error('Error:', error);
    });
}
//CRON START
cron.schedule(CRON_SETTING, () => {
  start(); 
});