"use strict";

const Homey = require("homey");
const moment = require("moment-timezone");

class MyApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    // A random second, so not every Homey asks at the same moment
    this.dailyPullSecond = Math.floor(Math.random() * 60);
    this.everyHour();
    this.everyQuarter();
    this.everyDay();
    this.log("MyApp has been initialized");
  }

  async onUninit() {
    this.log("App onUninit called");
    this.homey.removeAllListeners("everyhour");
    this.homey.removeAllListeners("everyquarter");
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

  everyQuarter() {
    const now = new Date();
    const nextQuarter = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      (Math.floor(now.getMinutes() / 15) + 1) * 15,
      0,
      50
    );
    const timeToNextQuarter = nextQuarter - now;
    this.homey.setTimeout(() => {
      this.homey.setInterval(async () => {
        this.homey.emit("everyquarter", true);
      }, 15 * 60 * 1000);
      this.homey.emit("everyquarter", true);
    }, timeToNextQuarter);
    this.log("everyQuarter job started");
  }

  // Today's daily pull at 13:05 Danish time, when tomorrow's prices are
  // usually out, as a timestamp
  getDailyPullTime() {
    return moment
      .tz("Europe/Copenhagen")
      .set({ hour: 13, minute: 5, second: this.dailyPullSecond, millisecond: 0 })
      .valueOf();
  }

  // Scheduled again every day, so it follows summer and winter time
  everyDay() {
    let nextPull = this.getDailyPullTime();
    if (nextPull <= Date.now()) {
      nextPull = moment.tz(nextPull, "Europe/Copenhagen").add(1, "day").valueOf();
    }
    this.homey.setTimeout(() => {
      this.homey.emit("everyday", true);
      this.everyDay();
    }, nextPull - Date.now());
    this.log("everyDay job started");
  }
}

module.exports = MyApp;
