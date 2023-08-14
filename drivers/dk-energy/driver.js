'use strict';

const { Driver } = require('homey');
const { v4 } = require('uuid');

class MyDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
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

}

module.exports = MyDriver;
