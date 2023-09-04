'use strict';

const { Driver } = require('homey');
const { v4 } = require('uuid');

class MyDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {

    // When cards
    this._devicesReceivedNewPrices = this.homey.flow.getDeviceTriggerCard("new-prices-received");
    this._devicesPriceHigherAvg = this.homey.flow.getDeviceTriggerCard("price-is-higher-than-avg-price");
    this._devicesPriceLessAvg = this.homey.flow.getDeviceTriggerCard("price-is-less-than-avg-price");
    this._devicesPriceLowest = this.homey.flow.getDeviceTriggerCard("price-is-lowest");
    this._devicesPriceHighest = this.homey.flow.getDeviceTriggerCard("price-is-highest");
    this._devicesPriceNegative = this.homey.flow.getDeviceTriggerCard("price-is-negative");

    // And cards
    const priceLessThanAvgCondition = this.homey.flow.getConditionCard('price-is-lower-than-average-price');
		priceLessThanAvgCondition.registerRunListener((args) => args.device.priceLessThanAvgCondition(args));

    const priceHigherThanAvgCondition = this.homey.flow.getConditionCard('price-is-higher-than-average-price');
		priceHigherThanAvgCondition.registerRunListener((args) => args.device.priceHigherThanAvgCondition(args));
    
    this.log('MyDriver has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    return [
      {
        name: 'DK-Energy',
        data: {
          id: v4(),
      },
      capabilities: [
        'meter_price_h0',
        'meter_price_h1',
        'meter_price_h2',
        'meter_price_h3',
        'meter_price_h4',
        'meter_price_h5',
        'meter_price_h6',
        'meter_price_h7',
        'meter_price_this_day_avg',
        'meter_price_this_day_lowest',
        'meter_price_this_day_highest',
      ],
      
    }
    ];
  }

  // FLOW WHEN CARDS
  triggerNewPricesReceivedFlow(device, tokens, state) {
    this._devicesReceivedNewPrices.trigger(device, tokens, state)
    .then(this.log("Flow 'new-prices-received' triggered"))
    .catch(this.error);
  }

  triggerPriceHigherAvgFlow(device, tokens, state) {
    this._devicesPriceHigherAvg.trigger(device, tokens, state)
    .then(this.log("Flow 'price-is-higher-than-avg-price' triggered"))
    .catch(this.error);
  }

  triggerPriceLessAvgFlow(device, tokens, state) {
    this._devicesPriceLessAvg.trigger(device, tokens, state)
    .then(this.log("Flow 'price-is-less-than-avg-price' triggered"))
    .catch(this.error);
  }

  triggerPriceIsLowestFlow(device, tokens, state) {
    this._devicesPriceLowest.trigger(device, tokens, state)
    .then(this.log("Flow 'price-is-lowest' triggered"))
    .catch(this.error);
  }

  triggerPriceIsHighestFlow(device, tokens, state) {
    this._devicesPriceHighest.trigger(device, tokens, state)
    .then(this.log("Flow 'price-is-highest' triggered"))
    .catch(this.error);
  }

  triggerPriceIsNegativeFlow(device, tokens, state) {
    this._devicesPriceNegative.trigger(device, tokens, state)
    .then(this.log("Flow 'price-is-negative' triggered"))
    .catch(this.error);
  }

}

module.exports = MyDriver;
