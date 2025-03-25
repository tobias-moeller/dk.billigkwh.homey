'use strict';

const _ = require("lodash");

module.exports = {
  async getPriceTable({ homey, query }) {
      var nullValue = [ { hour: 0, price: 0, change: 0, to: 0 }, { hour: 0, price: 0, change: 0, to: 0 }, { hour: 0, price: 0, change: 0, to: 0 }, { hour: 0, price: 0, change: 0, to: 0 }, { hour: 0, price: 0, change: 0, to: 0 }, { hour: 0, price: 0, change: 0, to: 0 }];
     
  
      if (homey.drivers.getDriver('dk-energy').getDevices().length == 0){
        return nullValue;
      };
  
      try {
        var device = homey.drivers.getDriver('dk-energy').getDevices()[0];
        
        var pricesForNextHours = await device.getMeterPricesForNextHours();
        
        var currentHour = (await device.getDanishDate()).getHours();
        
        var priceTable = _.chain(pricesForNextHours)
                          .map((price, index) => {
                            var change = 0;

                            if (index > 0)
                            {
                              var lastPrice = pricesForNextHours[index-1];
                              change = (price - lastPrice).toFixed(2);
                            }
                                      
                            return { hour: String(((currentHour + index) % 24)).padStart(2, '0'), price: price.toFixed(2), change: change, to: String(((currentHour + index + 1) % 24)).padStart(2, '0') };
                          })
                          .value()
                          ;

        return priceTable;
      } catch (e){
        return nullValue;
      }
    }
  };