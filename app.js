"use strict";

const Homey = require("homey");

class MyApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.everyHour();
    this.everyDay();
    this.log("MyApp has been initialized");
  }

  async onUninit() {
    this.log("App onUninit called");
    this.homey.removeAllListeners("everyhour");
    this.homey.removeAllListeners("everyday");
  }

  everyHour() {
    const now = new Date();
    const nextHour = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours() + 1,
      0,
      0,
      50
    );
    const timeToNextHour = nextHour - now;
    this.homey.setTimeout(() => {
      this.homey.setInterval(async () => {
        this.homey.emit("everyhour", true);
      }, 60 * 60 * 1000);
      // }, 5000);
      this.homey.emit("everyhour", true);
    }, timeToNextHour);
    //}, 5000);
    this.log("everyHour job started");
  }

  isSummerTime(dateToTest) {
    let jan = new Date(dateToTest.getFullYear(), 0, 1).getTimezoneOffset();
    let jul = new Date(dateToTest.getFullYear(), 6, 1).getTimezoneOffset();
    return Math.max(jan, jul) !== dateToTest.getTimezoneOffset();
  }

  getDanishTime() {
    const date = new Date();
    let timeDifference = 1;
    if (this.isSummerTime(date)) {
      timeDifference = 2;
    }
    date.setHours(date.getHours() + timeDifference);
    return date;
  }

  everyDay() {
    // Pull everday between 14-15 DK TIME
    const now = this.getDanishTime();
    const tomorrow = this.getDanishTime();
    if (tomorrow.getHours() > 14) {
      tomorrow.setDate(now.getDate() + 1);
    }
    tomorrow.setHours(14);
    const timeToNextDay = tomorrow - now;
    this.homey.setTimeout(() => {
      this.homey.setInterval(async () => {
        this.homey.emit("everyday", true);
      }, 24 * 60 * 60 * 1000);
      //}, 5000);
      this.homey.emit("everyday", true);
    }, timeToNextDay);
    //}, 5000);
    this.log("everyDay job started");
  }
}

module.exports = MyApp;
