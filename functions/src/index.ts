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
  intervals?: IntervalForecast[]
}

interface IntervalForecast {
  mountain: IntervalTemperatureGroupData
  valley: IntervalTemperatureGroupData
  probabilityOfPrecipitation: string
  rainfall: string
  /** Percentage */
  sun: number
  snowLine: string
  thunderstorm: string
  wind: string
}

interface IntervalTemperatureGroupData {
  max: string
  snow: string
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
    .map((index, dayElement): Forecast => {
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
      const result: Forecast = {
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
        mountain: getTemperatureGroupData($day.find('.group').eq(0)),
        valley: getTemperatureGroupData($day.find('.group').eq(1)),
        probabilityOfPrecipitation: $day.find('.rrp').text().trim(),
        rainfall: $day.find('.rrr').text().trim(),
        sun: $day.find('.sonne').text().trim(),
        snowLine: $day.find('.sgrenze').text().trim(),
        thunderstorm: $day.find('.wgew').text().trim(),
        wind: $day.find('.ff').text().trim(),
      };
      const $intervalContainer = $(`#forecast-day-${index}-intervals`);
      if ($intervalContainer.length) {
        result.intervals = [];
        const $intervals = $intervalContainer.find('.interval');
        $intervals.each((i, e) => {
          const $interval = $(e);
          const $nextInterval = $intervals.eq(i + 1);
          const temperatureMax = $interval.find('.group').eq(0).find('.tmax');
          if ($nextInterval.length) {
            const snow = $nextInterval.find('.group').eq(1).find('.nschnee');
            const sunMatch = $nextInterval.find('.sonne').attr('class').match(/sonne(\d+)/);
            const sun = sunMatch ? parseInt(sunMatch[1]) : 0;
            // @ts-ignore
            result.intervals.push({
              mountain: {
                max: temperatureMax.eq(0).text().trim(),
                snow: snow.eq(0).text().trim(),
              },
              valley: {
                max: temperatureMax.eq(1).text().trim(),
                snow: snow.eq(1).text().trim(),
              },
              probabilityOfPrecipitation: $nextInterval.find('.rrp').text().trim(),
              rainfall: $nextInterval.find('.rrr').text().trim(),
              sun,
              snowLine: $nextInterval.find('.sgrenze').text().trim(),
              thunderstorm: $nextInterval.find('.wgew').text().trim(),
              wind: $nextInterval.find('.ff').text().trim(),
            });
          }
        });
      }
      return result;
    })
    .get();
}

async function storeForecastsData(forecastsData: Forecast[]): Promise<string[]> {
  const db = admin.firestore();
  const forecastsCollection = db.collection('forecastsFixed');
  const ids = await Promise.all(
    forecastsData.map(async data => {
      const snapshot =
        await forecastsCollection
          .where('forecastDate', '==', data.forecastDate)
          .limit(1)
          .get();
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
  const [, hourStr, minute, meridiem] = timeMatch;
  const hour = parseInt(hourStr);
  const currentTime = now();
  let date = currentTime.set({
    hour: meridiem === 'PM' && hour !== 12 ? hour + 12 : hour,
    minute: parseInt(minute),
    second: 0,
    millisecond: 0,
  });
  if (currentTime < date) {
    date = date.minus({day: 1});
  }
  return {
    date: date.toJSDate(),
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

function formatDateTime(time: FirebaseFirestore.Timestamp | undefined) {
  return time && DateTime.fromMillis(time.toMillis()).toFormat('dd.MM. HH:mm');
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
    .onRun(async () => {
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
    .onRun(async () => {
      const forecastsData = await getForecast(forecastUrl);
      const documentIds = await storeForecastsData(forecastsData);
      console.log('stored', JSON.stringify(documentIds, null, 4));
    });

export const currentDate =
  functions.https.onRequest(async (request, response) => {
    response.send(DateTime.local().setZone('Europe/Berlin').toFormat('dd.MM. HH:mm'));
  });

export const get =
  functions.https.onRequest(async (request, response) => {
    const db = admin.firestore();
    const webcamsCollection = db.collection(request.query.collection);
    const doc = await webcamsCollection.doc(request.query.id).get();
    if (doc.exists) {
      const {id, createTime, updateTime} = doc;
      const data: any = doc.data();
      if (data.date) {
        data.date = formatDateTime(data.date);
      }
      if (data.forecastDate) {
        data.forecastDate = formatDateTime(data.forecastDate);
      }
      response.json({
        id,
        createTime: formatDateTime(createTime),
        updateTime: formatDateTime(updateTime),
        data,
      });
    } else {
      response.json(null);
    }
  });

// export const fix =
//   functions.https.onRequest(async (request, response) => {
//     const db = admin.firestore();
//     const webcamsCollection = db.collection(request.query.collection);
//     const doc =
//       await webcamsCollection.doc(request.query.id).get();
//     if (doc.exists) {
//       const data: any = doc.data();
//       console.log(request.query.id);
//       console.log(DateTime.fromJSDate(data.date.toDate()).plus({day: 1}).toJSDate());
//       await webcamsCollection.doc(request.query.id)
//         .update({
//           date:
//             DateTime.fromJSDate(data.date.toDate())
//               .plus({day: 1})
//               .toJSDate()
//         });
//       response.send('success');
//     } else {
//       response.json(null);
//     }
//   });

export const getInvalid =
  functions.https.onRequest(async (request, response) => {
    const db = admin.firestore();
    const webcamsCollection = db.collection(request.query.collection);
    const docs = await webcamsCollection.get();
    const invalidDocs: any[] = [];
    docs.forEach(doc => {
      const {id, createTime, updateTime} = doc;
      const data: any = doc.data();
      if (data.date.toMillis() > createTime.toMillis()) {
        data.date = formatDateTime(data.date);
        invalidDocs.push({
          id,
          createTime: formatDateTime(createTime),
          updateTime: formatDateTime(updateTime),
          data,
        });
      }
    });
    response.json(invalidDocs);
  });