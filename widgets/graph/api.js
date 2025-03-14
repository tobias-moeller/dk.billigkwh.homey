'use strict';

const _ = require("lodash");
const moment = require("moment-timezone");

module.exports = {
  async getPrices({ homey, query }) {
    
    var nullValue = [{ hour: 0, price: 0 }];

    if (homey.drivers.getDriver('dk-energy').getDevices().length == 0){
      return nullValue;
    };

    try {
      var device = homey.drivers.getDriver('dk-energy').getDevices()[0];
      
      var pricesForNextHours = await device.getMeterPricesForNextHours();
      
      var currentHour = (await device.getDanishDate()).getHours();
      var prices = _.chain(pricesForNextHours)
                    .map((price, index) => { return { 
                                hour: String(((currentHour + index) % 24)).padStart(2, '0'), 
                                price: price.toFixed(2) }
                    })
                    .take(6)
                    .value()
                    ;
      ;

      return prices;
    } catch (e){
      return nullValue;
    }
  }
};