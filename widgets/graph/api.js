'use strict';

const _ = require("lodash");

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