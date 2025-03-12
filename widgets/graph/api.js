'use strict';

module.exports = {
  async getPrices({ homey, query }) {
    
    
    var data = [
      {
        hour: 9,
        price: 2.24
      },
      {
        hour: 10,
        price: 2.11
      },
      {
        hour: 11,
        price: 3.40
      },
      {
        hour: 12,
        price: 2.95
      },
      {
        hour: 13,
        price: 4.05
      },
      {
        hour: 14,
        price: 2.01
      },
      {
        hour: 15,
        price: 4.22
      }


    ];
    
    // you can access query parameters like "/?foo=bar" through `query.foo`

    // you can access the App instance through homey.app
    // const result = await homey.app.getSomething();
    // return result;

    // perform other logic like mapping result data

    return data;
  },

};
