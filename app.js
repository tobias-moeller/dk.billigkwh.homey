"use strict";

const Homey = require("homey");
const moment = require("moment-timezone");

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
      //}, 5000);
      this.homey.emit("everyhour", true);
      }, timeToNextHour);
    //}, 5000);
    this.log("everyHour job started");
  }

  // Homey apps run in UTC, so shift by the Copenhagen offset (+1 winter, +2 summer)
  getDanishTime() {
    return new Date(Date.now() + moment.tz("Europe/Copenhagen").utcOffset() * 60000);
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
      //}, 30000);
      this.homey.emit("everyday", true);
    }, timeToNextDay);
    //}, 30000);
    this.log("everyDay job started");
  }
}

module.exports = MyApp;
