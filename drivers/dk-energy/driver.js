"use strict";

const { Driver } = require("homey");
const { v4 } = require("uuid");

class MyDriver extends Driver {
  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    // When cards
    this._devicesReceivedNewPrices = this.homey.flow.getDeviceTriggerCard(
      "new-prices-received"
    );
    this._devicesPriceHigherAvg = this.homey.flow.getDeviceTriggerCard(
      "price-is-higher-than-avg-price"
    );
    this._devicesPriceLessAvg = this.homey.flow.getDeviceTriggerCard(
      "price-is-less-than-avg-price"
    );
    this._devicesPriceLowest =
      this.homey.flow.getDeviceTriggerCard("price-is-lowest");
    this._devicesPriceHighest =
      this.homey.flow.getDeviceTriggerCard("price-is-highest");
    this._devicesPriceNegative =
      this.homey.flow.getDeviceTriggerCard("price-is-negative");
    this._devicesNewHour =
      this.homey.flow.getDeviceTriggerCard("new-hour-started");

    this._devicesPriceLowestBetween = this.homey.flow.getDeviceTriggerCard(
      "price-is-lowest-between"
    );
    this._devicesPriceLowestBetween.registerRunListener(async (args) =>
      args.device.priceLowestBetweenListener(args)
    );

    this._devicesLowestPeriodStartsBetween =
      this.homey.flow.getDeviceTriggerCard(
        "lowest-price-period-starts-between"
      );
    this._devicesLowestPeriodStartsBetween.registerRunListener(async (args) =>
      args.device.lowestPeriodStartsBetweenListener(args)
    );

    this._devicesLowestPricePeriod = this.homey.flow.getDeviceTriggerCard(
      "lowest-price-period"
    );
    this._devicesLowestPricePeriod.registerRunListener(async (args) =>
      args.device.lowestPricePeriodListener(args)
    );

    this._devicesPricePeriodHigherBetween =
      this.homey.flow.getDeviceTriggerCard("price-period-higher-between");
    this._devicesPricePeriodHigherBetween.registerRunListener(async (args) =>
      args.device.pricePeriodHigherBetweenListener(args)
    );

    // And cards
    const priceLessThanAvgCondition = this.homey.flow.getConditionCard(
      "price-is-lower-than-average-price"
    );
    priceLessThanAvgCondition.registerRunListener((args) =>
      args.device.priceLessThanAvgListener(args)
    );

    const priceHigherThanAvgCondition = this.homey.flow.getConditionCard(
      "price-is-higher-than-average-price"
    );
    priceHigherThanAvgCondition.registerRunListener((args) =>
      args.device.priceHigherThanAvgListener(args)
    );

    const priceOverValueCondition =
      this.homey.flow.getConditionCard("price-now-is-over");
    priceOverValueCondition.registerRunListener((args) =>
      args.device.priceOverValueListener(args)
    );

    const priceUnderValueCondition =
      this.homey.flow.getConditionCard("price-now-is-under");
    priceUnderValueCondition.registerRunListener((args) =>
      args.device.priceUnderValueListener(args)
    );

    const priceUnderAvgFromToCondition = this.homey.flow.getConditionCard(
      "price-this-hour-is-under-average-price-from-to"
    );
    priceUnderAvgFromToCondition.registerRunListener((args) =>
      args.device.priceUnderAvgBetweenClockListener(args)
    );

    const pricePeriodLowestCondition = this.homey.flow.getConditionCard(
      "the-lowest-price-period"
    );
    pricePeriodLowestCondition.registerRunListener((args) =>
      args.device.pricePeriodLowestListener(args)
    );

    const pricePeriodLowestBetweenCondition = this.homey.flow.getConditionCard(
      "the-lowest-price-period-between"
    );
    pricePeriodLowestBetweenCondition.registerRunListener((args) =>
      args.device.lowestPricePeriodBetweenListener(args)
    );

    this.log("MyDriver has been initialized");
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    return [
      {
        name: "DK-Energy",
        data: {
          id: v4(),
        },
        capabilities: [
          "meter_price_h0",
          "meter_price_h1",
          "meter_price_h2",
          "meter_price_h3",
          "meter_price_h4",
          "meter_price_h5",
          "meter_price_h6",
          "meter_price_h7",
          "meter_price_this_day_avg",
          "meter_price_this_day_lowest",
          "meter_price_this_day_highest",
          "meter_price_this_day_lowest_hour",
          "meter_price_this_day_highest_hour",
        ],
      },
    ];
  }

  // FLOW WHEN CARDS
  triggerNewPricesReceivedFlow(device, tokens, state) {
    this._devicesReceivedNewPrices
      .trigger(device, tokens, state)
      .then(this.log("Flow 'new-prices-received' triggered"))
      .catch(this.error);
  }

  triggerPriceHigherAvgFlow(device, tokens, state) {
    this._devicesPriceHigherAvg
      .trigger(device, tokens, state)
      .then(this.log("Flow 'price-is-higher-than-avg-price' triggered"))
      .catch(this.error);
  }

  triggerPriceLessAvgFlow(device, tokens, state) {
    this._devicesPriceLessAvg
      .trigger(device, tokens, state)
      .then(this.log("Flow 'price-is-less-than-avg-price' triggered"))
      .catch(this.error);
  }

  triggerPriceIsLowestFlow(device, tokens, state) {
    this._devicesPriceLowest
      .trigger(device, tokens, state)
      .then(this.log("Flow 'price-is-lowest' triggered"))
      .catch(this.error);
  }

  triggerPriceIsHighestFlow(device, tokens, state) {
    this._devicesPriceHighest
      .trigger(device, tokens, state)
      .then(this.log("Flow 'price-is-highest' triggered"))
      .catch(this.error);
  }

  triggerPriceIsNegativeFlow(device, tokens, state) {
    this._devicesPriceNegative
      .trigger(device, tokens, state)
      .then(this.log("Flow 'price-is-negative' triggered"))
      .catch(this.error);
  }

  triggerPriceLowestBetweenFlow(device, tokens, state) {
    this._devicesPriceLowestBetween
      .trigger(device, tokens, state)
      .then(this.log("Flow 'price-is-lowest-between' triggered"))
      .catch(this.error);
  }

  triggerNewHourFlow(device, tokens, state) {
    this._devicesNewHour
      .trigger(device, tokens, state)
      .then(this.log("Flow 'new-hour-started' triggered"))
      .catch(this.error);
  }

  triggerLowestPeriodStartsBetweenFlow(device, tokens, state) {
    this._devicesLowestPeriodStartsBetween
      .trigger(device, tokens, state)
      .then(this.log("Flow 'lowest-price-period-starts-between' triggered"))
      .catch(this.error);
  }

  triggerLowestPricePeriodFlow(device, tokens, state) {
    this._devicesLowestPricePeriod
      .trigger(device, tokens, state)
      .then(this.log("Flow 'lowest-price-period' triggered"))
      .catch(this.error);
  }

  triggerHighestPeriodeBetweenFlow(device, tokens, state) {
    this._devicesPricePeriodHigherBetween
      .trigger(device, tokens, state)
      .then(this.log("Flow 'price-period-higher-between' triggered"))
      .catch(this.error);
  }
}

module.exports = MyDriver;
