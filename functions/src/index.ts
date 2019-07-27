import axios from 'axios';
import * as cheerio from 'cheerio';
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp(functions.config().firebase);

const forecastUrl = 'https://www.bergfex.at/hintertux/wetter/prognose/';

function getTemperatureGroupData($temperatureGroup: Cheerio) {
  return {
    max: $temperatureGroup.find('.tmax').text(),
    min: $temperatureGroup.find('.tmin').text(),
    snow: $temperatureGroup.find('.nschnee').text().trim(),
  };
}

interface TemperatureGroupData {
  max: string
  min: string
  snow: string
}

interface Forecast {
  date: Date
  mountain: TemperatureGroupData
  valley: TemperatureGroupData
  probabilityOfPrecipitation: string
  rainfall: string
  sun: string
  snowLine: string
  thunderstorm: string
  wind: string
}

async function getForecast(url: string): Promise<Forecast[]> {
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

async function storeForecastsData(forecastsData: Forecast[]): Promise<string[]> {
  const db = admin.firestore();
  const forecastsCollection = db.collection('forecasts');
  return await Promise.all(
    forecastsData.map(async data => {
      const document = await forecastsCollection.add(data);
      return document.id;
    }));
}

export const forecast = functions.https.onRequest(async (request, response) => {
  const result = await getForecast(forecastUrl);
  response.send(JSON.stringify(result, null, 4));
});

export const storeForecast = functions.https.onRequest(async (request, response) => {
  const forecastsData = await getForecast(forecastUrl);
  const documentIds = await storeForecastsData(forecastsData);
  response.send(JSON.stringify(documentIds, null, 4));
});

export const scheduledStoreForecast =
  functions.pubsub.schedule('0 1 * * *').onRun(async (context) => {
    const forecastsData = await getForecast(forecastUrl);
    const documentIds = await storeForecastsData(forecastsData);
    console.log('stored', JSON.stringify(documentIds, null, 4));
  });