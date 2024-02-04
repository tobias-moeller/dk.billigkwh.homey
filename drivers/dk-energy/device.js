"use strict";

const { Device } = require("homey");
const https = require("https");
const util = require("util");

const setTimeoutPromise = util.promisify(setTimeout);

class MyDevice extends Device {
  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    await this.destroyListeners();
    this.restarting = false;
    this.device = this;
    this.prices = [];

    await this.getPrices();
    this.setMeterPrices();

    // Every hour
    this.eventListenerHour = async () => {
      this.log("New hour event received");
      this.setMeterPrices();

      // Trigger flow cards
      this.triggerPriceHigherOrLessThanAvgFlowCard();
      this.triggerPriceIsNegativeFlowCard();
      this.triggerNewHourFlowCard();
      this.triggerLowestPeriodStartsBetweenFlowCard();
      this.triggerPricePeriodHigherBetweenFlowCard();
    };
    this.homey.on("everyhour", this.eventListenerHour);

    // Every day
    this.eventListenerDay = async () => {
      this.log("New day event received");
      await this.getPrices();
    };
    this.homey.on("everyday", this.eventListenerDay);

    this.log("Energy-device has been initialized");
  }

  async destroyListeners() {
    if (this.eventListenerHour)
      this.homey.removeListener("everyhour", this.eventListenerHour);
    if (this.eventListenerDay)
      this.homey.removeListener("everyday", this.eventListenerDay);
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
    this.log("Redafg: " + Number(newSettings.redafg));
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
    const todaysPrices = this.getPricesByTimestamp(todaysTimestamp);
    const pricesHoursToRetrieve = 8; // Starting from the current hour (0)

    // Refresh date
    todaysDate = this.getDanishDate();

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
      const tomorrowsPrices = this.getPricesByTimestamp(tomorrowsTimestamp);
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

  getPriceNow() {
    let todaysDate = this.getDanishDate();
    todaysDate.setHours(0, 0, 0, 0);
    const todaysTimestamp = this.toTimestamp(todaysDate);

    const todaysPrices = this.getPricesByTimestamp(todaysTimestamp);
    const currentHour = this.getDanishDate().getHours();
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
      this.log("No prices found for timestamp: " + timestamp);
      return null;
    }
    return datePrices;
  }

  isSummerTime(dateToTest) {
    let jan = new Date(dateToTest.getFullYear(), 0, 1).getTimezoneOffset();
    let jul = new Date(dateToTest.getFullYear(), 6, 1).getTimezoneOffset();
    return Math.max(jan, jul) !== dateToTest.getTimezoneOffset();
  }

  getDanishDate() {
    const date = new Date();
    let timeDifference = 1;
    if (this.isSummerTime(date)) {
      timeDifference = 2;
    }
    date.setHours(date.getHours() + timeDifference);
    return date;
  }

  async getPrices() {
    const location = this.getSetting("location");
    const netCompany = this.getSetting("net_company");
    const product = this.getSetting("el_product");
    const redafg = Number(this.getSetting("redafg"));
    const data = await this.getPricesFromApi(
      location,
      netCompany,
      product,
      redafg
    );
    if (data.errorMessage) {
      throw new Error(data.errorMessage);
    }
    this.prices = data;

    // Trigger flow card
    this.triggerNewPricesRecievedFlowCard();
  }

  async getPricesFromApi(location, netCompany, product, redafg) {
    const options = {
      hostname: "billigkwh.dk",
      port: 443,
      path:
        "/api/Priser/HentPriser?sted=" +
        location +
        "&netselskab=" +
        netCompany +
        "&produkt=" +
        product +
        "&redafg=" +
        redafg,
      method: "GET",
    };
    this.log(
      "Trying to get prices for " +
        location +
        " " +
        netCompany +
        " " +
        product +
        " " +
        redafg
    );
    let retry = 0;
    let data = null;
    while (retry < 3) {
      try {
        data = await this.httpRequest(options);
        break;
      } catch (error) {
        retry++;
        this.log(error);
        this.log(`Retry ${retry} of 3`);
      }
    }
    if (retry >= 3) {
      throw new Error("Failed to retrieve prices from billigkwh.dk");
    }
    this.log("Prices retrieved from billigkwh.dk");
    return data;
  }

  async httpRequest(options) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve(JSON.parse(data));
        });
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
    const dayTwoPrices = this.getPricesByTimestamp(dayTwoTimestamp);

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
    const hour = parseInt(timeArray[0]);
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
      tokens = { price_now: priceNow };
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
