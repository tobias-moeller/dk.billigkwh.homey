"use strict";

const { Device } = require("homey");
const https = require("https");
const util = require("util");
const moment = require("moment-timezone");

const setTimeoutPromise = util.promisify(setTimeout);

const TIMEZONE = "Europe/Copenhagen";
const HOUR_MS = 60 * 60 * 1000;
const REPOSITORY_URL = "https://github.com/tobias-moeller/dk.billigkwh.homey";

// Net company ids that stromligning.dk no longer knows, mapped to their current id.
// "none" means no net company, so the supplierId parameter is omitted entirely.
const NET_COMPANY_ALIASES = {
  none: null,
  aal_el_net_c: "aal_el-net_c",
  midtfyns_elforsyning_c: "midtfyns_c",
};

// Groups the hourly prices into Danish calendar days, indexed by Danish hour.
// Uses the Copenhagen timezone so the offset is +1 in winter and +2 in summer.
function matchBilligKWHFormat(apiResponse) {
  if (!Array.isArray(apiResponse)) {
    throw new Error(
      "Unexpected response from stromligning.dk: " + JSON.stringify(apiResponse)
    );
  }

  const days = {};
  for (const item of apiResponse) {
    const local = moment.tz(item.date, TIMEZONE);
    const dayKey = local.format("YYYY-MM-DD");
    const hour = local.hour();

    if (!days[dayKey]) {
      days[dayKey] = {
        dato: `${dayKey}T00:00:00Z`,
        priser: [],
      };
    }

    // When DST ends 02:00 occurs twice, keep the first one
    if (days[dayKey].priser[hour] === undefined) {
      days[dayKey].priser[hour] = Math.round(item.price * 100) / 100;
    }
  }

  // When DST starts 02:00 does not exist, reuse the previous hour's price
  for (const day of Object.values(days)) {
    for (let i = 0; i < day.priser.length; i++) {
      if (day.priser[i] === undefined) {
        day.priser[i] = i > 0 ? day.priser[i - 1] : day.priser[i + 1];
      }
    }
  }

  return Object.values(days);
}

// Capabilities that are only added when the resolution is set to quarter
const QUARTER_CAPABILITIES = [
  "meter_price_quarter_now",
  "meter_price_quarter_next",
];

// Capabilities that are only added when the sell price is turned on
const SELL_PRICE_CAPABILITIES = [
  "meter_sell_price_now",
  "meter_sell_price_this_day_avg",
  "meter_sell_price_this_day_lowest",
  "meter_sell_price_this_day_highest",
];

// Minutes between retries when tomorrow's prices are missing after the daily
// pull, and until how many minutes after the daily pull each step is used
const RETRY_STEPS = [
  [2, 6],
  [5, 60],
  [15, null],
];

// Lengths of the resolutions stromligning.dk returns
const RESOLUTION_MS = {
  "15m": 15 * 60 * 1000,
  "1h": HOUR_MS,
};

// Turns the prices into slots with a start and an end, using the resolution
// of each price, so known prices and forecasts can be mixed
function toSlots(apiResponse) {
  return apiResponse.map((item) => {
    if (!(item.resolution in RESOLUTION_MS)) {
      throw new Error(
        "Unexpected resolution from stromligning.dk: " + item.resolution
      );
    }
    const start = Date.parse(item.date);
    return {
      start,
      end: start + RESOLUTION_MS[item.resolution],
      price: item.price,
      forecast: item.forecast == true,
    };
  });
}

// Hourly prices in the format of the API, from prices in any resolution
function toHourPrices(apiResponse) {
  return toHourSlots(toSlots(apiResponse)).map((slot) => ({
    date: new Date(slot.start).toISOString(),
    price: slot.price,
  }));
}

// Averages the slots per hour. Danish hours start at the same time as UTC
// hours, so the hour can be found from the UTC timestamp.
function toHourSlots(slots) {
  const hours = new Map();
  for (const slot of slots) {
    const start = Math.floor(slot.start / HOUR_MS) * HOUR_MS;
    if (!hours.has(start)) {
      hours.set(start, { start, sum: 0, duration: 0, forecast: false });
    }
    const hour = hours.get(start);
    const duration = slot.end - slot.start;
    hour.sum += slot.price * duration;
    hour.duration += duration;
    hour.forecast = hour.forecast || slot.forecast;
  }
  return [...hours.values()].map((hour) => ({
    start: hour.start,
    end: hour.start + HOUR_MS,
    price: Math.round((hour.sum / hour.duration) * 100) / 100,
    forecast: hour.forecast,
  }));
}

class MyDevice extends Device {
  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    await this.destroyListeners();
    this.restarting = false;
    this.device = this;
    this.prices = [];
    this.forecastPrices = [];
    this.slots = [];
    this.sellSlots = [];

    await this.updateOptionalCapabilities();
    await this.getPrices();
    this.setMeterPrices();
    this.setQuarterPrices();
    this.setSellPrices();
    this.scheduleTomorrowRetry();

    // Every hour
    this.eventListenerHour = async () => {
      this.log("New hour event received");
      let pulled = false;

      // Retry if the last pull failed, e.g. when there was no connection at startup
      if (this.prices.length == 0) {
        this.log("No prices available, retrying pull");
        await this.getPrices();
        pulled = true;
      }
      // Retry the sell price if the last pull failed
      if (!pulled && this.prices.length > 0 && this.isSellPriceOn() && this.sellSlots.length == 0) {
        this.log("No sell prices available, retrying pull");
        await this.getSellPrices();
      }
      this.setMeterPrices();
      this.setSellPrices();
      if (this.prices.length == 0) {
        return;
      }

      // Pull the new forecasts
      if (!pulled && this.isForecastUpdateHour()) {
        this.log("Pull new forecasts from stromligning.dk");
        await this.getPrices();
      }

      // Trigger flow cards
      this.triggerPriceHigherOrLessThanAvgFlowCard();
      this.triggerPriceIsNegativeFlowCard();
      this.triggerNewHourFlowCard();
      this.triggerLowestPeriodStartsBetweenFlowCard();
      this.triggerPricePeriodHigherBetweenFlowCard();
    };
    this.homey.on("everyhour", this.eventListenerHour);

    // Every quarter, only used with the quarter resolution
    this.eventListenerQuarter = async () => {
      if (!this.isQuarterResolution() || this.prices.length == 0) {
        return;
      }
      this.log("New quarter event received");
      this.setQuarterPrices();
      this.setSellPrices();
      this.triggerNewQuarterFlowCard();
    };
    this.homey.on("everyquarter", this.eventListenerQuarter);

    // Every day
    this.eventListenerDay = async () => {
      this.log("New day event received");
      await this.getPrices();
      if (!this.isTommorowsPricesAvailable()) {
        this.log("Did not recieve tommorows prices from daily pull");
        this.scheduleTomorrowRetry();
      }
    };
    this.homey.on("everyday", this.eventListenerDay);

    this.log("Energy-device has been initialized");
  }

  async destroyListeners() {
    if (this.eventListenerHour)
      this.homey.removeListener("everyhour", this.eventListenerHour);
    if (this.eventListenerQuarter)
      this.homey.removeListener("everyquarter", this.eventListenerQuarter);
    if (this.eventListenerDay)
      this.homey.removeListener("everyday", this.eventListenerDay);
    this.homey.clearTimeout(this.tomorrowRetry);
  }

  // When tomorrow's prices are missing after the daily pull, retry every 2
  // minutes at first, then every 5 until an hour after it, then every 15,
  // until they are here or the day ends
  scheduleTomorrowRetry() {
    this.homey.clearTimeout(this.tomorrowRetry);
    const dailyPull = this.homey.app.getDailyPullTime();
    const now = Date.now();
    if (now < dailyPull || this.isTommorowsPricesAvailable()) {
      return;
    }

    const elapsed = now - dailyPull;
    let retry;
    for (const [minutes, limit] of RETRY_STEPS) {
      const interval = minutes * 60 * 1000;
      retry = dailyPull + (Math.floor(elapsed / interval) + 1) * interval;
      if (limit == null || retry - dailyPull <= limit * 60 * 1000) {
        break;
      }
    }
    const midnight = moment.tz(TIMEZONE).add(1, "day").startOf("day").valueOf();
    if (retry >= midnight) {
      this.log("Tomorrow's prices did not come today, stop retrying");
      return;
    }

    this.log("Retry pull for tomorrow's prices at " + new Date(retry).toISOString());
    this.tomorrowRetry = this.homey.setTimeout(async () => {
      this.log("Retry daily pull from stromligning.dk");
      await this.getPrices();
      this.setMeterPrices();
      this.setSellPrices();
      if (this.isTommorowsPricesAvailable()) {
        this.log("Got tommorows prices from retry pull");
      } else {
        this.log("Did not recieve tommorows prices from retry pull");
        this.scheduleTomorrowRetry();
      }
    }, retry - now);
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log("Energy-device has been added");
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log("Energy-device settings where changed");
    this.log("Netcompany: " + newSettings.net_company);
    this.log("Location: " + newSettings.location);
    this.log("Product: " + newSettings.el_product);
    // Prices for new settings count as new prices
    await this.unsetStoreValue("last_known_price").catch(this.error);
    this.restartDevice(1000);
  }

  async restartDevice(delay) {
    if (this.restarting) return;
    this.restarting = true;
    await this.destroyListeners();
    const dly = delay || 2000;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    await setTimeoutPromise(dly).then(() => this.onInit());
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log("Energy-device was renamed to: " + name);
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.destroyListeners();
    this.log("Energy-device has been deleted");
  }

  isQuarterResolution() {
    return this.getSetting("resolution") == "quarter";
  }

  // Adds or removes the capabilities of the optional settings, so a device
  // with the default settings has the same capabilities as before
  async updateOptionalCapabilities() {
    const quarter = this.isQuarterResolution();
    for (const capability of QUARTER_CAPABILITIES) {
      await this.setCapabilityPresent(capability, quarter);
    }
    const sellPrice = this.isSellPriceOn();
    for (const capability of SELL_PRICE_CAPABILITIES) {
      await this.setCapabilityPresent(capability, sellPrice);
    }
  }

  isSellPriceOn() {
    return this.getSetting("sell_price") == true;
  }

  // Sell price now and today's lowest, highest and average. null when there
  // is no sell price for the time.
  getSellPriceStats() {
    const now = Date.now();
    const slot = this.sellSlots.find(
      (slot) => slot.start <= now && now < slot.end
    );
    const dayStart = moment.tz(TIMEZONE).startOf("day").valueOf();
    const dayEnd = moment.tz(TIMEZONE).add(1, "day").startOf("day").valueOf();
    const today = this.sellSlots.filter(
      (slot) => !slot.forecast && slot.start >= dayStart && slot.start < dayEnd
    );
    const round = (price) => Math.round(price * 100) / 100;

    const stats = {
      now: slot ? round(slot.price) : null,
      min: null,
      max: null,
      average: null,
    };
    if (today.length > 0) {
      const prices = today.map((slot) => slot.price);
      const duration = today.reduce((a, b) => a + (b.end - b.start), 0);
      stats.min = round(Math.min(...prices));
      stats.max = round(Math.max(...prices));
      stats.average = round(
        today.reduce((a, b) => a + b.price * (b.end - b.start), 0) / duration
      );
    }
    return stats;
  }

  setSellPrices() {
    if (!this.isSellPriceOn()) {
      return;
    }
    const stats = this.getSellPriceStats();
    this.setCapabilityValue("meter_sell_price_now", stats.now).catch(this.error);
    this.setCapabilityValue("meter_sell_price_this_day_lowest", stats.min).catch(
      this.error
    );
    this.setCapabilityValue(
      "meter_sell_price_this_day_highest",
      stats.max
    ).catch(this.error);
    this.setCapabilityValue("meter_sell_price_this_day_avg", stats.average).catch(
      this.error
    );
  }

  // A failing sell price leaves the buy prices working and shows a warning
  async getSellPrices() {
    let data;
    try {
      data = await this.getSellPricesFromApi(this.getSetting("net_company"));
      this.sellSlots = toSlots(data);
    } catch (error) {
      this.log(error);
      await this.setWarning("Sell price: " + error.message).catch(this.error);
      return false;
    }
    await this.unsetWarning().catch(this.error);
    return true;
  }

  async setCapabilityPresent(capability, present) {
    if (present && !this.hasCapability(capability)) {
      this.log("Adding capability '" + capability + "'");
      await this.addCapability(capability).catch(this.error);
    } else if (!present && this.hasCapability(capability)) {
      this.log("Removing capability '" + capability + "'");
      await this.removeCapability(capability).catch(this.error);
    }
  }

  // The price slot that covers the time, using the resolution of each price
  getSlotAt(time) {
    return this.slots.find((slot) => slot.start <= time && time < slot.end);
  }

  // Prices for this and the next quarter. A forecast covers a whole hour.
  getQuarterPrices() {
    const now = this.getSlotAt(Date.now());
    const next = now ? this.getSlotAt(now.end) : null;
    return {
      now: now ? Math.round(now.price * 100) / 100 : 0,
      next: next ? Math.round(next.price * 100) / 100 : 0,
    };
  }

  setQuarterPrices() {
    if (!this.isQuarterResolution()) {
      return;
    }
    const quarterPrices = this.getQuarterPrices();
    this.setCapabilityValue("meter_price_quarter_now", quarterPrices.now).catch(
      this.error
    );
    this.setCapabilityValue(
      "meter_price_quarter_next",
      quarterPrices.next
    ).catch(this.error);
  }

  isTommorowsPricesAvailable() {
    let tomorrowsDate = this.getDanishDate();
    tomorrowsDate.setDate(tomorrowsDate.getDate() + 1);
    tomorrowsDate.setHours(0, 0, 0, 0);
    const tomorrowsTimestamp = this.toTimestamp(tomorrowsDate);

    // Get prices for tomorrow
    const tomorrowsPrices = this.getPricesByTimestamp(tomorrowsTimestamp);
    if (tomorrowsPrices == null) {
      return false;
    }
    return true;
  }

  setMeterPrices() {
    const meterPrices = this.getMeterPricesForNextHours();
    for (let i = 0; i < meterPrices.length; i++) {
      this.setCapabilityValue("meter_price_h" + i, meterPrices[i]);
    }

    // Get timestamp for today
    let todaysDate = this.getDanishDate();
    todaysDate.setHours(0, 0, 0, 0);
    const todaysTimestamp = this.toTimestamp(todaysDate);

    // Get daily stats
    const dailyStats = this.getDailyStats(todaysTimestamp);

    // Fix missing capabilities
    const capabilities = this.getCapabilities();
    if (!capabilities.includes("meter_price_this_day_lowest_hour")) {
      this.log("Adding capability 'lowest_hour'");
      const promise = this.addCapability("meter_price_this_day_lowest_hour");
      promise.then(() => {
        const lowestHourPromise = this.setCapabilityValue(
          "meter_price_this_day_lowest_hour",
          dailyStats.minHour
        );
        lowestHourPromise.catch((error) => {
          throw Error("Kunne ikke sætte capability værdi 'lowest_hour'");
        });
      });
      promise.catch((error) => {
        throw Error("Noget gik galt med at tilføje 'lowest_hour' capability");
      });
    } else {
      const lowestHourPromise = this.setCapabilityValue(
        "meter_price_this_day_lowest_hour",
        dailyStats.minHour
      );
      lowestHourPromise.catch((error) => {
        throw Error("Kunne ikke sætte capability værdi 'lowest_hour'");
      });
    }

    if (!capabilities.includes("meter_price_this_day_highest_hour")) {
      this.log("Adding capability 'highest_hour'");
      const promise = this.addCapability("meter_price_this_day_highest_hour");
      promise.then(() => {
        const highestHourPromise = this.setCapabilityValue(
          "meter_price_this_day_highest_hour",
          dailyStats.maxHour
        );
        highestHourPromise.catch((error) => {
          throw Error("Kunne ikke sætte capability værdi 'highest_hour'");
        });
      });

      promise.catch((error) => {
        throw Error("Noget gik galt med at tilføje 'highest_hour' capability");
      });
    } else {
      const highestHourPromise = this.setCapabilityValue(
        "meter_price_this_day_highest_hour",
        dailyStats.maxHour
      );
      highestHourPromise.catch((error) => {
        throw Error("Kunne ikke sætte capability værdi 'highest_hour'");
      });
    }

    // Set daily stats
    this.setCapabilityValue("meter_price_this_day_lowest", dailyStats.min);

    this.setCapabilityValue("meter_price_this_day_highest", dailyStats.max);

    this.setCapabilityValue("meter_price_this_day_avg", dailyStats.average);

    this.log("Meter prices has been set");
  }

  getDailyStats(timestamp) {
    const timestampPrices = this.getPricesByTimestamp(timestamp);

    if (timestampPrices == null) {
      return {
        average: 0,
        min: 0,
        minHour: 0,
        max: 0,
        maxHour: 0,
      };
    }

    // Calculate average
    let dailyStats = {};
    dailyStats.average = parseFloat(
      (
        timestampPrices.reduce((a, b) => a + b, 0) / timestampPrices.length
      ).toFixed(2)
    );

    // Calculate min price and find hour
    for (let i = 0; i < Object.keys(timestampPrices).length; i++) {
      if (dailyStats.min == null || dailyStats.min > timestampPrices[i]) {
        dailyStats.min = timestampPrices[i];
        dailyStats.minHour = i;
      }
    }

    // Calculate max price and find hour
    for (let i = 0; i < Object.keys(timestampPrices).length; i++) {
      if (dailyStats.max == null || dailyStats.max < timestampPrices[i]) {
        dailyStats.max = timestampPrices[i];
        dailyStats.maxHour = i;
      }
    }
    return dailyStats;
  }

  getMeterPricesForNextHours() {
    // Get timestamp for today
    let todaysDate = this.getDanishDate();
    todaysDate.setHours(0, 0, 0, 0);
    const todaysTimestamp = this.toTimestamp(todaysDate);

    // Get prices for today
    let todaysPrices = this.getPricesByTimestamp(todaysTimestamp);
    const pricesHoursToRetrieve = 8; // Starting from the current hour (0)

    // Refresh date
    todaysDate = this.getDanishDate();

    if (todaysPrices == null) {
      this.log("Todays prices == null, returning 0");
      this.log(this.prices);
      todaysPrices = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ];
    }

    // Get prices for the next 8 hours
    const meterPrices = [];
    let hourIndexCounter = 0;
    for (
      let i = todaysDate.getHours();
      i < Object.keys(todaysPrices).length;
      i++
    ) {
      meterPrices[hourIndexCounter] = todaysPrices[i];
      hourIndexCounter++;
      if (hourIndexCounter >= pricesHoursToRetrieve) {
        break;
      }
    }

    // Get the rest of the prices from the next day
    if (hourIndexCounter < pricesHoursToRetrieve) {
      // Get timestamp for tomorrow
      let tomorrowsDate = this.getDanishDate();
      tomorrowsDate.setDate(tomorrowsDate.getDate() + 1);
      tomorrowsDate.setHours(0, 0, 0, 0);
      const tomorrowsTimestamp = this.toTimestamp(tomorrowsDate);

      // Get prices for tomorrow
      let tomorrowsPrices = this.getPricesByTimestamp(tomorrowsTimestamp);
      if (tomorrowsPrices == null) {
        this.log("Tomorrow prices == null, returning 0");
        this.log(this.prices);
        tomorrowsPrices = [
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0,
        ];
      }

      for (let i = 0; i < Object.keys(tomorrowsPrices).length; i++) {
        meterPrices[hourIndexCounter] = tomorrowsPrices[i];
        hourIndexCounter++;
        if (hourIndexCounter >= pricesHoursToRetrieve) {
          break;
        }
      }
    }
    return meterPrices;
  }

  // Hourly prices from the current hour, with forecasts after the known prices
  // when they are turned on
  getHourlyPrices(hours) {
    const currentHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    return toHourSlots(this.slots)
      .filter((slot) => slot.start >= currentHour)
      .slice(0, hours);
  }

  getPriceNow(retry = true) {
    let todaysDate = this.getDanishDate();
    const currentHour = todaysDate.getHours();
    todaysDate.setHours(0, 0, 0, 0);
    const todaysTimestamp = this.toTimestamp(todaysDate);

    const todaysPrices = this.getPricesByTimestamp(todaysTimestamp);

    if (todaysPrices == null) {
      this.log(this.prices);
      if (retry) {
        return this.getPriceNow(false);
      } else {
        throw Error("Cant get todays prices from getPriceNow");
      }
    }
    return todaysPrices[currentHour];
  }

  toTimestamp(date) {
    return date.toISOString().split(".")[0] + "Z";
  }

  getPricesByTimestamp(timestamp) {
    let datePrices = [];
    for (let i = 0; i < Object.keys(this.prices).length; i++) {
      if (this.prices[i].dato == timestamp) {
        datePrices = this.prices[i].priser;
        break;
      }
    }
    if (datePrices == null || datePrices[0] == null) {
      this.log("Fail: No prices found for timestamp: " + timestamp);
      return null;
    }
    this.log("Success: Found prices for " + timestamp);
    return datePrices;
  }

  isDST(dt) {
    return moment(dt).tz("Europe/Copenhagen").isDST();
  }

  getDanishDate() {
    const utcDate = new Date();
    const isDST = this.isDST(utcDate);
    const timeDifference = isDST ? 2 : 1;
    const danishDate = new Date(utcDate.getTime() + timeDifference * 3600000);

    return danishDate;
  }

  // Returns true when prices were retrieved. On failure the device is marked
  // unavailable with the reason, and the hourly event retries the pull.
  async getPrices() {
    const location = this.getSetting("location");
    const netCompany = this.getSetting("net_company");
    const product = this.getSetting("el_product");
    let data;
    let slots;
    try {
      data = await this.getPricesFromApi(location, netCompany, product);
      slots = toSlots(data);
    } catch (error) {
      this.log(error);
      await this.setUnavailable(error.message).catch(this.error);
      return false;
    }
    // Forecasts are kept apart, so the cards for known prices do not use them.
    // The cards for hours always get hourly prices.
    const knownPrices = data.filter((item) => !item.forecast);
    this.prices = matchBilligKWHFormat(
      this.isQuarterResolution() ? toHourPrices(knownPrices) : knownPrices
    );
    this.forecastPrices = matchBilligKWHFormat(
      data.filter((item) => item.forecast)
    );
    this.slots = slots;
    await this.setAvailable().catch(this.error);

    if (this.isSellPriceOn()) {
      await this.getSellPrices();
    }

    // Only trigger "new prices received" when prices have arrived that the
    // device did not have before, e.g. tomorrow's prices. The last known price
    // is kept in the store, so a restart does not trigger it again.
    const lastKnownPrice =
      knownPrices.length > 0
        ? Date.parse(knownPrices[knownPrices.length - 1].date)
        : null;
    const storedLastKnownPrice = this.getStoreValue("last_known_price");
    if (
      lastKnownPrice != null &&
      (storedLastKnownPrice == null || lastKnownPrice > storedLastKnownPrice)
    ) {
      await this.setStoreValue("last_known_price", lastKnownPrice).catch(
        this.error
      );
      this.triggerNewPricesRecievedFlowCard();
    }
    return true;
  }

  // stromligning.dk updates the forecasts at 00, 06 and 18 UTC and at 11:50
  // Danish time, so they are pulled the hour after
  isForecastUpdateHour() {
    if (!this.getSetting("forecast")) {
      return false;
    }
    const utcHour = new Date().getUTCHours();
    const danishHour = this.getDanishDate().getUTCHours();
    return [1, 7, 19].includes(utcHour) || danishHour == 12;
  }

  async getPricesFromApi(location, netCompany, product) {
    // stromligning.dk interprets "from" as Danish local time
    const startTime = moment.tz(TIMEZONE).format("YYYY-MM-DD") + "T00%3A00%3A00";

    const supplierId = await this.getSupplierId(netCompany);

    const path =
      "/api/prices?from=" +
      startTime +
      (this.isQuarterResolution() ? "" : "&aggregation=1h") +
      "&lean=true&priceArea=" +
      encodeURIComponent(location) +
      (supplierId ? "&supplierId=" + encodeURIComponent(supplierId) : "") +
      "&productId=" +
      encodeURIComponent(product) +
      (this.getSetting("forecast") ? "&forecast=true" : "");

    this.log(
      "Trying to get prices for " +
        location +
        " " +
        netCompany +
        " " +
        product +
        " -> " +
        `https://stromligning.dk${path}`
    );
    return this.requestPrices(path);
  }

  // The sell price is the spot price excl. VAT minus the production tariffs
  // of Energinet and the net company, so it needs a net company
  async getSellPricesFromApi(netCompany) {
    const startTime = moment.tz(TIMEZONE).format("YYYY-MM-DD") + "T00%3A00%3A00";

    const supplierId = await this.getSupplierId(netCompany);
    if (!supplierId) {
      throw new Error(
        "The sell price needs a net company, choose one in the device settings"
      );
    }

    const path =
      "/api/prices/production?from=" +
      startTime +
      (this.isQuarterResolution() ? "" : "&aggregation=1h") +
      "&lean=true&supplierId=" +
      encodeURIComponent(supplierId) +
      (this.getSetting("forecast") ? "&forecast=true" : "");

    this.log(
      "Trying to get sell prices for " +
        netCompany +
        " -> " +
        `https://stromligning.dk${path}`
    );
    return this.requestPrices(path);
  }

  async getSupplierId(netCompany) {
    if (netCompany == "auto") {
      return this.findNetCompany();
    }
    return netCompany in NET_COMPANY_ALIASES
      ? NET_COMPANY_ALIASES[netCompany]
      : netCompany;
  }

  // Requests prices from stromligning.dk and retries when it fails
  async requestPrices(path) {
    const options = {
      hostname: "stromligning.dk",
      port: 443,
      path,
      method: "GET",
      timeout: 30000,
    };
    const fullUrl = `https://${options.hostname}${path}`;
    let retry = 0;
    let data = null;
    let lastError = null;
    while (retry < 3) {
      try {
        data = await this.httpRequest(options);
        if (!Array.isArray(data)) {
          throw new Error(
            "Unexpected response from stromligning.dk: " + JSON.stringify(data)
          );
        }
        break;
      } catch (error) {
        retry++;
        lastError = error;
        this.error(
          `stromligning.dk request failed (attempt ${retry}/3): ${error.message}`,
          `\nURL: ${fullUrl}`,
          error.statusCode != null ? `\nStatus: ${error.statusCode}` : ""
        );
        // A 4xx means the settings are invalid, retrying will not help and
        // only uses up the rate limit (15 requests per 15 minutes)
        if (error.statusCode >= 400 && error.statusCode < 500) {
          throw new Error(
            `stromligning.dk rejected the settings: ${error.message} (URL: ${fullUrl})`
          );
        }
        this.log(`Retry ${retry} of 3`);
        if (retry < 3) {
          await setTimeoutPromise(5000 * retry);
        }
      }
    }
    if (retry >= 3) {
      throw new Error(
        `Failed to retrieve prices from stromligning.dk after 3 attempts. ` +
          `URL: ${fullUrl}. Last error: ${lastError && lastError.message}`
      );
    }
    this.log("Prices retrieved from stromligning.dk");
    return data;
  }

  // Finds the net company from Homey's location. The result is kept in the
  // store, so stromligning.dk is only asked again when Homey has moved.
  async findNetCompany() {
    const lat = this.homey.geolocation.getLatitude();
    const long = this.homey.geolocation.getLongitude();
    if (!Number.isFinite(lat) || !Number.isFinite(long)) {
      throw new Error(
        "Homey has no location, choose a net company in the device settings"
      );
    }

    const found = this.getStoreValue("found_net_company");
    if (found && found.lat == lat && found.long == long) {
      return found.id;
    }

    const path =
      "/api/suppliers/find?lat=" +
      encodeURIComponent(lat) +
      "&long=" +
      encodeURIComponent(long);
    const options = {
      hostname: "stromligning.dk",
      port: 443,
      path,
      method: "GET",
      timeout: 30000,
    };
    let suppliers;
    try {
      suppliers = await this.httpRequest(options);
    } catch (error) {
      throw new Error(
        `Could not find the net company from Homey's location (${error.message}), choose a net company in the device settings`
      );
    }
    if (!Array.isArray(suppliers) || suppliers.length == 0 || !suppliers[0].id) {
      throw new Error(
        "Could not find the net company from Homey's location, choose a net company in the device settings"
      );
    }

    const supplier = suppliers[0];
    this.log(
      "Found net company " + supplier.id + " (" + supplier.name + ") from Homey's location"
    );
    await this.setStoreValue("found_net_company", { lat, long, id: supplier.id });
    return supplier.id;
  }

  async httpRequest(options) {
    // Without a User-Agent the request shows up as Go-http-client at stromligning.dk
    const headers = {
      ...options.headers,
      "User-Agent": `Stromligning-Homey/${this.homey.manifest.version} (+${REPOSITORY_URL})`,
    };
    return new Promise((resolve, reject) => {
      const req = https.request({ ...options, headers }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch (e) {
            body = data;
          }
          if (res.statusCode < 200 || res.statusCode >= 300 || (body && body.error)) {
            const error = new Error(
              `HTTP ${res.statusCode}: ${(body && body.error) || data}`.slice(0, 200)
            );
            error.statusCode = (body && body.error) ? 400 : res.statusCode;
            reject(error);
            return;
          }
          resolve(body);
        });
      });
      req.on("timeout", () => {
        req.destroy(new Error("Request to stromligning.dk timed out"));
      });
      req.on("error", (e) => {
        reject(e);
      });
      req.end();
    });
  }

  isValidTimeRange(currentHour, periode, from, to) {
    if (this.hoursBetween(from, to) < periode) {
      throw new Error("Periode kan ikke være større end tidsintervallet");
    }

    if (from < 15 && to < from) {
      throw new Error(
        "Fra tiden kan ikke være før 15:00, da priserne først er tilgængelige fra kl 15:00"
      );
    }
    if (!this.isBetween(currentHour, from, to) || to == currentHour) {
      this.log(
        "Skipping flow card: Price is lowest between, not between from and to"
      );
      return false;
    }
    return true;
  }

  hoursBetween(from, to) {
    if (from <= to) {
      return to - from;
    } else {
      return 24 - from + to;
    }
  }

  // Calculate lowest price periode between clock
  calculateIntervalBetweenClock(date, periode, from, to, scanLowest = true) {
    const combinedPrices = this.getCombinedPricesArray(date, from, to);
    let avgIndexes = null;
    let avgValue = null;

    if (to < from) {
      to = this.convertToCombinedIndex(to);
    }

    for (let i = 0; i < combinedPrices.length; i++) {
      if (i < from + periode) {
        continue;
      } else if (i > to) {
        break;
      }
      let startIndex = i - periode;
      const tempArray = combinedPrices.slice(startIndex, i);
      let tempAvg = parseFloat(
        (tempArray.reduce((a, b) => a + b, 0) / tempArray.length).toFixed(2)
      );

      if (
        avgValue == null ||
        (avgValue > tempAvg && scanLowest) ||
        (avgValue < tempAvg && !scanLowest)
      ) {
        avgIndexes = [];
        for (let j = startIndex; j < i; j++) {
          avgIndexes.push(j);
        }
        avgValue = tempAvg;
      }
    }
    this.log("Found Indexes: " + avgIndexes);
    return avgIndexes;
  }

  convertFromCombinedIndex(number) {
    return number - 24;
  }

  convertToCombinedIndex(number) {
    return number + 24;
  }

  getCombinedPricesArray(date, from, to) {
    let currentHour = date.getHours();

    if (
      this.isBetween(currentHour, from, to) &&
      currentHour < to &&
      currentHour < from
    ) {
      this.log("Over midnight detected");
      date.setDate(date.getDate() - 1);
    }

    date.setHours(0, 0, 0, 0);
    const dayOneTimestamp = this.toTimestamp(date);
    const dayOnePrices = this.getPricesByTimestamp(dayOneTimestamp);

    date.setDate(date.getDate() + 1);
    const dayTwoTimestamp = this.toTimestamp(date);
    let dayTwoPrices = this.getPricesByTimestamp(dayTwoTimestamp);

    // Before tomorrow's prices are out, use the forecast if the user chose it
    if (dayTwoPrices == null && this.getSetting("forecast_in_period_cards")) {
      const forecastDay = this.forecastPrices.find(
        (day) => day.dato == dayTwoTimestamp
      );
      if (forecastDay) {
        this.log("Using forecast for " + dayTwoTimestamp);
        dayTwoPrices = forecastDay.priser;
      }
    }

    let combinedPrices = [];
    for (let i = 0; i < Object.keys(dayOnePrices).length; i++) {
      combinedPrices.push(dayOnePrices[i]);
    }
    if (dayTwoPrices != null) {
      for (let i = 0; i < Object.keys(dayTwoPrices).length; i++) {
        combinedPrices.push(dayTwoPrices[i]);
      }
    }
    return combinedPrices;
  }

  // Check if the current hour is between the given interval
  isBetween(currentHour, from, to) {
    if (from < to) {
      return currentHour >= from && currentHour < to;
    } else {
      return currentHour >= from || currentHour <= to;
    }
  }

  // Convert string time arguments to number
  // Example: '10:01' = 11
  // Example: '10:59' = 11
  // Example: '11:00' = 11
  // Example: '23:01 = 0
  convertStringTimeToNumber(time) {
    const timeArray = time.split(":");
    let hour = parseInt(timeArray[0]);
    const minute = parseInt(timeArray[1]);
    if (minute > 0) {
      hour = hour + 1;
      if (hour > 23) {
        hour = 0;
      }
    }
    return hour;
  }

  // WHEN triggers/listeners

  // Trigger new prices recieved flow card
  triggerNewPricesRecievedFlowCard() {
    this.log("Triggering flow card: New prices recieved");

    let date = this.getDanishDate();
    date.setHours(0, 0, 0, 0);
    const todaysTimestamp = this.toTimestamp(date);

    date.setDate(date.getDate() + 1);
    const tomorrowsTimestamp = this.toTimestamp(date);

    const todayStats = this.getDailyStats(todaysTimestamp);
    const tomorrowStats = this.getDailyStats(tomorrowsTimestamp);

    const tokens = {
      todays_price_lowest: todayStats.min,
      todays_price_highest: todayStats.max,
      todays_price_avg: todayStats.average,

      tomorrow_price_lowest: tomorrowStats.min,
      tomorrow_price_highest: tomorrowStats.max,
      tomorrow_price_avg: tomorrowStats.average,
    };
    let state = {};
    this.driver.ready().then(() => {
      this.driver.triggerNewPricesReceivedFlow(this.device, tokens, state);
    });
  }

  // Trigger price higher/less than average price flow card
  triggerPriceHigherOrLessThanAvgFlowCard() {
    const currentPrice = this.getPriceNow();

    const date = this.getDanishDate();
    date.setHours(0, 0, 0, 0);
    const timestamp = this.toTimestamp(date);
    const avgPrice = this.getDailyStats(timestamp).average;
    const tokens = {
      price_now: currentPrice,
      price_avg: avgPrice,
    };

    let state = {};
    if (currentPrice > avgPrice) {
      this.log("Triggering flow card: Price is higher than average price");
      this.driver.ready().then(() => {
        this.driver.triggerPriceHigherAvgFlow(this.device, tokens, state);
      });
    } else if (currentPrice < avgPrice) {
      this.log("Triggering flow card: Price is less than average price");
      this.driver.ready().then(() => {
        this.driver.triggerPriceLessAvgFlow(this.device, tokens, state);
      });
    }
  }

  // Trigger price is negative flow card
  triggerPriceIsNegativeFlowCard() {
    const priceNow = this.getPriceNow();
    if (priceNow < 0) {
      this.log("Triggering flow card: Price is negative");
      const tokens = { price_now: priceNow };
      let state = {};
      this.driver.ready().then(() => {
        this.driver.triggerPriceIsNegativeFlow(this.device, tokens, state);
      });
    }
  }

  // Trigger new hour flow card
  triggerNewHourFlowCard() {
    this.log("Triggering flow card: New hour started");

    const meterPrices = this.getMeterPricesForNextHours();
    const tokens = {
      price: meterPrices[0],
      "price+1": meterPrices[1],
      "price+2": meterPrices[2],
      "price+3": meterPrices[3],
      "price+4": meterPrices[4],
      "price+5": meterPrices[5],
    };
    let state = {};
    this.driver.ready().then(() => {
      this.driver.triggerNewHourFlow(this.device, tokens, state);
    });
  }

  // Trigger new quarter flow card
  triggerNewQuarterFlowCard() {
    this.log("Triggering flow card: New quarter started");

    const quarterPrices = this.getQuarterPrices();
    const tokens = {
      price: quarterPrices.now,
      "price+1": quarterPrices.next,
    };
    let state = {};
    this.driver.ready().then(() => {
      this.driver.triggerNewQuarterFlow(this.device, tokens, state);
    });
  }

  // Trigger lowest price period starts between flow card
  triggerLowestPeriodStartsBetweenFlowCard() {
    this.log("Triggering flow card: Price is lowest between");
    const tokens = { price_now: this.getPriceNow() };
    let state = {};
    this.driver.ready().then(() => {
      this.driver.triggerLowestPeriodStartsBetweenFlow(
        this.device,
        tokens,
        state
      );
    });
  }

  // Flow lowest price period starts between listener
  lowestPeriodStartsBetweenListener(args) {
    const date = this.getDanishDate();
    let currentHour = date.getHours();

    const period = args.period;
    const from = this.convertStringTimeToNumber(args.from);
    const to = this.convertStringTimeToNumber(args.to);

    this.log("Arguments - Period: " + period + " from: " + from + " to: " + to);

    if (!this.isValidTimeRange(currentHour, period, from, to)) {
      return false;
    }

    const avgIndexes = this.calculateIntervalBetweenClock(
      date,
      period,
      from,
      to,
      true
    );

    if (avgIndexes[0] > 23) {
      avgIndexes[0] = this.convertFromCombinedIndex(avgIndexes[0]);
      this.log(
        'Converted index from "combined" to "normal" index: ' + avgIndexes[0]
      );
    }

    if (currentHour == avgIndexes[0]) {
      return true;
    }
    return false;
  }

  // Trigger price period higher between flow card
  triggerPricePeriodHigherBetweenFlowCard() {
    this.log("Triggering flow card: Price period higher between");
    const tokens = {};
    let state = {};
    this.driver.ready().then(() => {
      this.driver.triggerHighestPeriodeBetweenFlow(this.device, tokens, state);
    });
  }

  // Flow price period higher between listener
  pricePeriodHigherBetweenListener(args) {
    const date = this.getDanishDate();
    let currentHour = date.getHours();

    const period = args.period;
    const from = this.convertStringTimeToNumber(args.from);
    const to = this.convertStringTimeToNumber(args.to);

    this.log("Arguments - Period: " + period + " from: " + from + " to: " + to);

    if (!this.isValidTimeRange(currentHour, period, from, to)) {
      return false;
    }

    const avgIndexes = this.calculateIntervalBetweenClock(
      date,
      period,
      from,
      to,
      false
    );

    if (avgIndexes[0] > 23) {
      avgIndexes[0] = this.convertFromCombinedIndex(avgIndexes[0]);
      this.log(
        'Converted index from "combined" to "normal" index: ' + avgIndexes[0]
      );
    }

    if (currentHour == avgIndexes[0]) {
      return true;
    }
    return false;
  }

  // AND listeners

  // Lowest price period within the next hours Listener. Uses forecasts after
  // the known prices when they are turned on. A period that has already
  // started counts, so the condition stays true for the whole period.
  lowestPeriodWithinHoursListener(args) {
    const period = args.period;
    const hours = args.hours;
    if (period > hours) {
      throw new Error("Periode kan ikke være større end antal timer");
    }

    const now = Date.now();
    const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const hourSlots = toHourSlots(this.slots).filter(
      (slot) =>
        slot.start >= currentHour - (period - 1) * HOUR_MS &&
        slot.end <= currentHour + hours * HOUR_MS
    );

    let lowest = null;
    for (let i = 0; i + period <= hourSlots.length; i++) {
      const block = hourSlots.slice(i, i + period);
      // Skip blocks with a gap in the prices
      if (block[period - 1].start - block[0].start != (period - 1) * HOUR_MS) {
        continue;
      }
      const avg = block.reduce((a, b) => a + b.price, 0) / period;
      if (lowest == null || avg < lowest.avg) {
        lowest = { start: block[0].start, end: block[period - 1].end, avg };
      }
    }

    if (lowest == null) {
      this.log("No prices for a period of " + period + " hours");
      return false;
    }
    this.log(
      "Lowest period: " +
        new Date(lowest.start).toISOString() +
        " - " +
        new Date(lowest.end).toISOString()
    );
    return lowest.start <= now && now < lowest.end;
  }

  // Price is less than average Listerner
  priceLessThanAvgListener(args) {
    const currentPrice = this.getPriceNow();
    const avgPrice = this.getDailyStats(
      this.toTimestamp(this.getDanishDate())
    ).average;
    if (currentPrice < avgPrice) {
      return true;
    }
    return false;
  }

  // Price is higher than average Listerner
  priceHigherThanAvgListener(args) {
    const currentPrice = this.getPriceNow();
    const avgPrice = this.getDailyStats(
      this.toTimestamp(this.getDanishDate())
    ).average;
    if (currentPrice > avgPrice) {
      return true;
    }
    return false;
  }

  // Price is over value Listener
  priceOverValueListener(args) {
    const currentPrice = this.getPriceNow();
    if (currentPrice > args.price) {
      return true;
    }
    return false;
  }

  // Price this quarter is over value Listener
  priceQuarterOverValueListener(args) {
    if (!this.isQuarterResolution()) {
      throw new Error("Sæt opløsning til kvarter i enhedens indstillinger");
    }
    const quarterPrices = this.getQuarterPrices();
    if (quarterPrices.now > args.price) {
      return true;
    }
    return false;
  }

  // Sell price is over value Listener
  sellPriceOverValueListener(args) {
    const sellPrice = this.getSellPriceNow();
    if (sellPrice > args.price) {
      return true;
    }
    return false;
  }

  // Buy price minus sell price is over value Listener. Uses the buy price
  // in the resolution chosen in the device settings.
  buyMinusSellPriceOverValueListener(args) {
    const sellPrice = this.getSellPriceNow();
    const buySlot = this.getSlotAt(Date.now());
    if (!buySlot) {
      throw new Error("Der er ingen købspris for nu");
    }
    if (buySlot.price - sellPrice > args.price) {
      return true;
    }
    return false;
  }

  getSellPriceNow() {
    if (!this.isSellPriceOn()) {
      throw new Error("Slå salgspris til i enhedens indstillinger");
    }
    const sellPrice = this.getSellPriceStats().now;
    if (sellPrice == null) {
      throw new Error("Der er ingen salgspris for nu");
    }
    return sellPrice;
  }

  // Price is under value Listener
  priceUnderValueListener(args) {
    const currentPrice = this.getPriceNow();
    if (currentPrice < args.price) {
      return true;
    }
    return false;
  }

  // Price is under average price between clock Listener
  priceUnderAvgBetweenClockListener(args) {
    if (args.from >= args.to) {
      throw new Error("Fra tiden kan ikke være større end til tiden");
    }
    const date = this.getDanishDate();
    date.setHours(0, 0, 0, 0);
    const timestamp = this.toTimestamp(date);
    const pricesBetweenTime = this.getPricesByTimestamp(timestamp).slice(
      args.from,
      args.to
    );

    const avgPrice = parseFloat(
      (
        pricesBetweenTime.reduce((a, b) => a + b, 0) / pricesBetweenTime.length
      ).toFixed(2)
    );

    if (avgPrice > this.getPriceNow()) {
      return true;
    }
    return false;
  }

  // Price periode is lowest Listener
  pricePeriodLowestListener(args) {
    const date = this.getDanishDate();
    const currentHour = date.getHours();
    const period = args.period;
    const from = 0;
    const to = 23;

    if (!this.isValidTimeRange(currentHour, period, from, to)) {
      return false;
    }

    const avgIndexes = this.calculateIntervalBetweenClock(
      date,
      period,
      from,
      to,
      true
    );

    for (let i = 0; i < avgIndexes.length; i++) {
      if (avgIndexes[i] > 23) {
        avgIndexes[i] = this.convertFromCombinedIndex(avgIndexes[i]);
        this.log(
          'Converted index from "combined" to "normal" index: ' + avgIndexes[i]
        );
        if (currentHour == avgIndexes[i]) {
          return true;
        }
      }
    }
  }

  // Price periode is lowest between Listener
  lowestPricePeriodBetweenListener(args) {
    const date = this.getDanishDate();
    const currentHour = date.getHours();
    const period = args.period;
    const from = args.from;
    const to = args.to;

    if (!this.isValidTimeRange(currentHour, period, from, to)) {
      return false;
    }

    const avgIndexes = this.calculateIntervalBetweenClock(
      date,
      period,
      from,
      to,
      true
    );

    this.log(avgIndexes);
    for (let i = 0; i < avgIndexes.length; i++) {
      if (avgIndexes[i] > 23) {
        avgIndexes[i] = this.convertFromCombinedIndex(avgIndexes[i]);
        this.log(
          'Converted index from "combined" to "normal" index: ' + avgIndexes[i]
        );
        if (currentHour == avgIndexes[i]) {
          return true;
        }
      }
    }
  }
}
module.exports = MyDevice;
