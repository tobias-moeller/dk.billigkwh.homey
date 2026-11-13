'use strict';

const _ = require("lodash");
const moment = require("moment-timezone");

module.exports = {
  async getPrices({ homey, query }) {
    
    var hours     = +query.hours;
    var nullValue = _.chain([
                     { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 },
                     { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 },
                     { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 },
                     { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }, { hour: 0, price: 0 }
                    ])
                    .take(hours)
                    .value()
                    ;
   

    if (homey.drivers.getDriver('dk-energy').getDevices().length == 0){
      return nullValue;
    };

    try {
      var device = homey.drivers.getDriver('dk-energy').getDevices()[0];

      // With forecasts the prices come with their own hour and a forecast flag
      if (query.forecast == 'true') {
        return _.chain(device.getHourlyPrices(hours))
                .map((slot) => { return {
                            hour: moment.tz(slot.start, 'Europe/Copenhagen').format('HH'),
                            price: slot.price.toFixed(2),
                            forecast: slot.forecast }
                })
                .value()
                ;
      }
      
      var pricesForNextHours = await device.getMeterPricesForNextHours();
      var currentHour = (await device.getDanishDate()).getHours();
      
      var prices = _.chain(pricesForNextHours)
                    .map((price, index) => { return { 
                                hour: String(((currentHour + index) % 24)).padStart(2, '0'), 
                                price: price.toFixed(2) }
                    })
                    .take(hours)
                    .value()
                    ;
      ;

      return prices;
    } catch (e){
      return nullValue;
    }
  }

  

};