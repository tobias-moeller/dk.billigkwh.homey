'use strict';

const { Device } = require('homey');
const https = require('https');
const util = require('util');

const setTimeoutPromise = util.promisify(setTimeout);

class MyDevice extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
	await this.destroyListeners();
	this.restarting = false;

	const settings = await this.getSettings();
    const pureData = await this.fetchPricesFromApi(
		settings.location, 
		settings.net_company, 
		settings.el_product, 
		settings.redafg
		);

	this.storePurePrices(pureData);
	const mappedData = this.mapPrices(pureData);
	this.setSensorValues(mappedData);

	this.eventListenerHour = async () => {
		this.log('New hour event received');
		const settings = await this.getSettings();
		const mappedData = this.mapPrices(settings.prices);
		this.setSensorValues(mappedData);
	};
	this.homey.on('everyhour', this.eventListenerHour);

	this.eventListenerDay = async () => {
		this.log('New day event received');
		const pureData = await this.fetchPricesFromApi(
			settings.location, 
			settings.net_company, 
			settings.el_product, 
			settings.redafg
			);
	
		this.storePurePrices(pureData);
	};
	this.homey.on('everyday', this.eventListenerHour);

	this.log('MyDevice has been initialized');
  }

  async destroyListeners() {
	if (this.eventListenerHour) this.homey.removeListener('everyhour', this.eventListenerHour);
	if (this.eventListenerDay) this.homey.removeListener('everyday', this.eventListenerDay);
  }

  async storePurePrices(data){
	await this.setSettings({"prices" : data});
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('MyDevice settings where changed');
	this.restartDevice(1000);
  }

  async restartDevice(delay) {
	if (this.restarting) return;
	this.restarting = true;
	await this.destroyListeners();
	const dly = delay || 2000;
	this.log(`Device will restart in ${dly / 1000} seconds`);
	// this.setUnavailable('Device is restarting. Wait a few minutes!');
	await setTimeoutPromise(dly).then(() => this.onInit());
}

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
	this.destroyListeners();
    this.log('MyDevice has been deleted');
  }

  setSensorValues(mappedData){
	for (const [key, value] of Object.entries(mappedData)) {
		this.setCapabilityValue(key, value);
		this.log(key + " Is set to: " + value);
	}
  }

  mapPrices(data){
	const mappedData = {
		"meter_price_h0" : null,
		"meter_price_h1" : null,
		"meter_price_h2" : null,
		"meter_price_h3" : null,
		"meter_price_h4" : null,
		"meter_price_h5" : null,
		"meter_price_h6" : null,
		"meter_price_h7" : null,
		"meter_price_this_day_lowest" : null,
		"meter_price_this_day_highest" : null,
		"meter_price_this_day_avg" : null
	}

	const today = this.getDanishTime();
	const date = this.getDanishTime();
	date.setHours(0,0,0,0);
	const todaysTimestamp = this.toTimestamp(date);

	const todaysPrices = this.getPricesArray(data, todaysTimestamp);
	if (todaysPrices == null) {
		throw Error("Cant get todays prices");
	}

	let mappedIndexCounter = 0;
	for (let i = today.getHours(); i < Object.keys(todaysPrices).length; i++){
		mappedData["meter_price_h" + mappedIndexCounter] = todaysPrices[i];
		if (mappedIndexCounter == 7){
			break;
		}

		mappedIndexCounter++;
	}

	// We need next days prices to fill out
	if (mappedData["meter_price_h7"] == null) {
		date.setDate(date.getDate() + 1);
		
		const tomorrowTimestamp = this.toTimestamp(date);
		const tomorrowPrices =  this.getPricesArray(data, tomorrowTimestamp);
		if (todaysPrices == null) {
			throw Error("Cant get tomorrows prices");
		}

		for (let i = 0; i < Object.keys(tomorrowPrices).length; i++){
			mappedData["meter_price_h" + mappedIndexCounter] = tomorrowPrices[i];
			if (mappedIndexCounter == 7){
				break;
			}
			mappedIndexCounter++;
		}
	}

	mappedData["meter_price_this_day_lowest"] = Math.min(...todaysPrices);
	mappedData["meter_price_this_day_highest"] = Math.max(...todaysPrices);
	mappedData["meter_price_this_day_avg"] = todaysPrices.reduce((a, b) => a + b, 0) / todaysPrices.length;

	return mappedData;
  }

  getPricesArray(data, timestamp){
	let prices = null;
	for (let i = 0; i < Object.keys(data).length; i++){
		if(data[i]["dato"] == timestamp){
			prices = data[i]["priser"];
			break;
		}
	}
	return prices;
  }

  toTimestamp(date){
    return date.toISOString().split('.')[0]+"Z";
  }

  getDanishTime(){
	const timeDifference = 2;
	const date = new Date();
	const totalHours = date.getHours() + timeDifference;
	if (totalHours > 23){
		date.setDate(date.getDate() + 1);
		const val = totalHours - 24;
		date.setHours(date.getHours() + val);
	}
	else {
		date.setHours(date.getHours() + timeDifference);
	}
	return date;
  }

  async fetchPricesFromApi(location, netCompany, product, redafg){
		const options = {
			hostname: "billigkwh.dk",
			port: 443,
			path: "/api/Priser/HentPriser?sted=" + location + "&netselskab=" + netCompany + "&produkt=" + product + "&redafg=" + redafg,
			headers: {
			},
			method: 'GET',
		};

		return await this._makeRequest(options, "");
	}

  async _makeRequest(options, data, timeout) {
		try {
			const result = await this._makeHttpsRequest(options, data, timeout);
			const contentType = result.headers['content-type'];
			if (!/application\/json/.test(contentType)) {
				throw Error(`Expected json but received ${contentType}: ${result.body}`);
			}
			if (result.statusCode !== 200) {
				throw Error(`HTTP request Failed. Status Code: ${result.statusCode}`);
			}
			const json = JSON.parse(result.body);
			return Promise.resolve(json);
		} catch (error) {
			return Promise.reject(error);
		}
	}

    _makeHttpsRequest(options, postData, timeout){
        return new Promise((resolve, reject) => {
			const opts = options;
			opts.timeout = timeout || this.timeout;
			const req = https.request(opts, (res) => {
				let resBody = '';
				res.on('data', (chunk) => {
					resBody += chunk;
				});
				res.once('end', () => {
					if (!res.complete) {
						return reject(Error('The connection was terminated while the message was still being sent'));
					}
					res.body = resBody;
					return resolve(res);
				});
			});
			req.on('error', (e) => {
				req.destroy();
				return reject(e);
			});
			req.on('timeout', () => {
				req.destroy();
			});
			req.end(postData);
		});
    }

}

module.exports = MyDevice;
