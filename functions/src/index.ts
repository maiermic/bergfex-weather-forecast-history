import axios from 'axios';
import {DateTime} from 'luxon';
import * as cheerio from 'cheerio';
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp(functions.config().firebase);

const forecastUrl = 'https://www.bergfex.at/hintertux/wetter/prognose/';
const webcamUrl = 'https://webtv.feratel.com/webtv/?design=v3&pg=121E2E32-862A-4791-8936-B41853615FB6&cam=5552';

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
  /**
   * Issue date of forecast.
   */
  forecastDate: Date
  /**
   * Forecasted date
   */
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

function now() {
  return DateTime.local().setZone('Europe/Berlin');
}

async function getForecast(url: string): Promise<Forecast[]> {
  const {data} = await axios.get(url);
  const $ = cheerio.load(data);
  const $container = $('.forecast9d-container');
  let forecastDate: DateTime | null = null;
  return $container
    .find('.day')
    .map((_, dayElement): Forecast => {
      const $day = $(dayElement);
      const title = $day.attr('title');
      const dateMatch = title.match(/(\d+)\.(\d+)\.(\d+)/);
      if (!dateMatch) {
        throw Error(`Could not parse date in title: "${title}"`);
      }
      const [, day, month, year] = dateMatch;
      const timeStr = $container.find('.time').text();
      const timeMatch = timeStr.match(/(\d+):(\d+)/);
      if (!timeMatch) {
        throw Error(`Could not parse time: "${timeStr}"`);
      }
      const [, hour, minute] = timeMatch;
      const $mountain = $day.find('.group').eq(0);
      const $valley = $day.find('.group').eq(1);
      const mountain = getTemperatureGroupData($mountain);
      const valley = getTemperatureGroupData($valley);
      if (forecastDate === null) {
        forecastDate = now().set({
          year: parseInt(year),
          month: parseInt(month),
          day: parseInt(day),
          hour: parseInt(hour),
          minute: parseInt(minute),
          second: 0,
          millisecond: 0,
        });
      }
      return {
        forecastDate: forecastDate.toJSDate(),
        date: now().set({
          year: parseInt(year),
          month: parseInt(month),
          day: parseInt(day),
          hour: 0,
          minute: 0,
          second: 0,
          millisecond: 0,
        }).toJSDate(),
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
  const forecastsCollection = db.collection('forecastsFixed');
  const ids = await Promise.all(
    forecastsData.map(async data => {
      const snapshot =
        await forecastsCollection.where('date', '==', data.date).limit(1).get();
      if (snapshot.empty) {
        const document = await forecastsCollection.add(data);
        return document.id;
      }
      return undefined;
    }));
  return ids.filter((id): id is string => typeof id === "string");
}

interface WebcamData {
  date: Date
  temperature: string
  wind: string
}

async function getWebcamData(url: string): Promise<WebcamData> {
  const {data} = await axios.get(url);
  const $ = cheerio.load(data);
  const timeStr = $('#video_clock_div').text().trim();
  const timeMatch = timeStr.match(/(\d+):(\d+) ([PA]M)/);
  if (!timeMatch) {
    throw Error(`Could not parse time: "${timeStr}"`);
  }
  const [, hour, minute, meridiem] = timeMatch;
  return {
    date: now().set({
      hour: meridiem === 'PM' ? parseInt(hour) + 12 : parseInt(hour),
      minute: parseInt(minute),
      second: 0,
      millisecond: 0,
    }).toJSDate(),
    temperature: $('#hidden_wetter_div').attr('value'),
    wind: $('#hidden_wetterWind_div').attr('value'),
  };
}

async function storeWebcamData(data: WebcamData): Promise<string | null> {
  const db = admin.firestore();
  const webcamsCollection = db.collection('webcamsFixed');
  const snapshot =
    await webcamsCollection.where('date', '==', data.date).limit(1).get();
  if (snapshot.empty) {
    const document = await webcamsCollection.add(data);
    return document.id;
  }
  return null;
}

export const webcam =
  functions.https.onRequest(async (request, response) => {
    const result = await getWebcamData(webcamUrl);
    response.send(JSON.stringify(result, null, 4));
  });

export const storeWebcam = functions.https.onRequest(async (request, response) => {
  const data = await getWebcamData(webcamUrl);
  const documentId = await storeWebcamData(data);
  response.send(JSON.stringify(documentId, null, 4));
});

export const scheduledStoreWebcam =
  functions.pubsub.schedule('every 10 mins from 05:00 to 22:00')
    .timeZone('Europe/Berlin')
    .onRun(async (context) => {
      const data = await getWebcamData(webcamUrl);
      const documentId = await storeWebcamData(data);
      console.log('stored', JSON.stringify(documentId, null, 4));
    });

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
  functions.pubsub.schedule('every 1 hours')
    .timeZone('Europe/Berlin')
    .onRun(async (context) => {
      const forecastsData = await getForecast(forecastUrl);
      const documentIds = await storeForecastsData(forecastsData);
      console.log('stored', JSON.stringify(documentIds, null, 4));
    });

export const currentDate =
  functions.https.onRequest(async (request, response) => {
    response.send(DateTime.local().setZone('Europe/Berlin').toFormat('dd.MM. HH:mm'));
  });