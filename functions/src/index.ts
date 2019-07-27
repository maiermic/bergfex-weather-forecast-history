import axios from 'axios';
import * as cheerio from 'cheerio';
import * as functions from 'firebase-functions';

function getTemperatureGroupData($temperatureGroup: Cheerio) {
  return {
    max: $temperatureGroup.find('.tmax').text(),
    min: $temperatureGroup.find('.tmin').text(),
    snow: $temperatureGroup.find('.nschnee').text().trim(),
  };
}

async function getForecast(url: string) {
  const {data} = await axios.get(url);
  const $ = cheerio.load(data);
  const $container = $('.forecast9d-container');
  return $container
    .find('.day')
    .map((_, dayElement) => {
      const $day = $(dayElement);
      const date = new Date();
      const title = $day.attr('title');
      const dateMatch = title.match(/(\d+)\.(\d+)\.(\d+)/);
      if (!dateMatch) {
        throw Error(`Could not parse date in title: "${title}"`);
      }
      const [, day, month, year] = dateMatch;
      date.setUTCFullYear(parseInt(year), parseInt(month) - 1, parseInt(day));
      const timeStr = $container.find('.time').text();
      const timeMatch = timeStr.match(/(\d+):(\d+)/);
      if (!timeMatch) {
        throw Error(`Could not parse time: "${timeStr}"`);
      }
      const [, hours, minutes] = timeMatch;
      date.setUTCHours(parseInt(hours), parseInt(minutes));
      const $mountain = $day.find('.group').eq(0);
      const $valley = $day.find('.group').eq(1);
      const mountain = getTemperatureGroupData($mountain);
      const valley = getTemperatureGroupData($valley);
      return {
        date,
        mountain,
        valley,
        probabilityOfPrecipitation: $day.find('.rrp').text().trim(),
        rainfall: $day.find('.rrp').text().trim(),
        sun: $day.find('.sonne').text().trim(),
        snowLine: $day.find('.sgrenze').text().trim(),
        thunderstorm: $day.find('.wgew').text().trim(),
        wind: $day.find('.ff').text().trim(),
      };
    })
    .get();
}

export const forecast = functions.https.onRequest(async (request, response) => {
  const result = await getForecast('https://www.bergfex.at/hintertux/wetter/prognose/');
  response.send(JSON.stringify(result, null, 4));
});
