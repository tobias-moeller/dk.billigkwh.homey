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
	this.device = this;

	this.priceValues = {
		"h0" : null,
		"h1" : null,
		"h2" : null,
		"h3" : null,
		"h4" : null,
		"h5" : null,
		"h6" : null,
		"h7" : null,
		"today_prices" : null,
		"today_lowest" : 0,
		"today_highest" : 0,
		"today_avg" : 0,
		"tomorrow_lowest" : 0,
		"tomorrow_highest" : 0,
		"tomorrow_avg" : 0,
	}

    await this.getAndStorePricesFromApi();
	this.setSensorValues();

	this.eventListenerHour = async () => {
		this.log('New hour event received');
		const settings = await this.getSettings();
		this.mapPrices(settings.prices);
		this.setSensorValues();
		this.log("Sensor values is now updated")

		// Trigger Flows
		await this.priceAvgTrigger();
		await this.priceIsLowestHighestTrigger();
		await this.priceLowestBetweenTrigger();
	};
	this.homey.on('everyhour', this.eventListenerHour);

	this.eventListenerDay = async () => {
		this.log('New day event received');
		await this.getAndStorePricesFromApi();
	};
	this.homey.on('everyday', this.eventListenerDay);

	this.log('Energy-device has been initialized');
  }

  async destroyListeners() {
	if (this.eventListenerHour) this.homey.removeListener('everyhour', this.eventListenerHour);
	if (this.eventListenerDay) this.homey.removeListener('everyday', this.eventListenerDay);
  }

  async getAndStorePricesFromApi() {
	const settings = await this.getSettings();
	const data = await this.fetchPricesFromApi(
		settings.location, 
		settings.net_company, 
		settings.el_product, 
		Number(settings.redafg)
		);

	await this.setSettings({"prices" : data});
	this.mapPrices(data);

	// This trigger flow new-prices recieved
	await this.newPricesReceivedTrigger();

	this.log("Stored new price data");

	return data;
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Energy-device has been added');
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
    this.log('Energy-device settings where changed');
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
    this.log('Energy-device was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
	this.destroyListeners();
    this.log('Energy-device has been deleted');
  }

  setSensorValues(){
	this.setCapabilityValue("meter_price_h0", this.priceValues["h0"]);
	this.setCapabilityValue("meter_price_h1", this.priceValues["h1"]);
	this.setCapabilityValue("meter_price_h2", this.priceValues["h2"]);
	this.setCapabilityValue("meter_price_h3", this.priceValues["h3"]);
	this.setCapabilityValue("meter_price_h4", this.priceValues["h4"]);
	this.setCapabilityValue("meter_price_h5", this.priceValues["h5"]);
	this.setCapabilityValue("meter_price_h6", this.priceValues["h6"]);
	this.setCapabilityValue("meter_price_h7", this.priceValues["h7"]);
	this.setCapabilityValue("meter_price_this_day_lowest", this.priceValues["today_lowest"]);
	this.setCapabilityValue("meter_price_this_day_highest", this.priceValues["today_highest"]);
	this.setCapabilityValue("meter_price_this_day_avg", this.priceValues["today_avg"]);
  }

  mapPrices(data){
	const today = this.getDanishTime();
	const date = this.getDanishTime();
	date.setHours(0,0,0,0);
	const todaysTimestamp = this.toTimestamp(date);

	const todaysPrices = this.getPricesArray(data, todaysTimestamp);
	if (todaysPrices != null) {
		// Reset h values to null
		for (let i = 0; i < 8; i++){
			this.priceValues["h" + i] = null;
		}

		let mappedIndexCounter = 0;
		for (let i = today.getHours(); i < Object.keys(todaysPrices).length; i++){
			this.priceValues["h" + mappedIndexCounter] = todaysPrices[i];
			if (mappedIndexCounter == 7){
				break;
			}
			mappedIndexCounter++;
		}
		this.priceValues["today_prices"] = todaysPrices;
		this.priceValues["today_lowest"] = Math.min(...todaysPrices);
		this.priceValues["today_highest"] = Math.max(...todaysPrices);
		this.priceValues["today_avg"] = parseFloat((todaysPrices.reduce((a, b) => a + b, 0) / todaysPrices.length).toFixed(2));

		// We need next days prices to fill out
		date.setDate(date.getDate() + 1);
		const tomorrowTimestamp = this.toTimestamp(date);
		const tomorrowPrices =  this.getPricesArray(data, tomorrowTimestamp);
		if (tomorrowPrices != null) {
			if (this.priceValues["h7"] == null) {
				for (let i = 0; i < Object.keys(tomorrowPrices).length; i++){
					this.priceValues["h" + mappedIndexCounter] = tomorrowPrices[i];
					if (mappedIndexCounter == 7){
						break;
					}
					mappedIndexCounter++;
				}
			} 
			this.priceValues["tomorrow_lowest"] = Math.min(...todaysPrices);
			this.priceValues["tomorrow_highest"] = Math.max(...todaysPrices);
			this.priceValues["tomorrow_avg"] = parseFloat((todaysPrices.reduce((a, b) => a + b, 0) / todaysPrices.length).toFixed(2));
		}else {
			this.priceValues["tomorrow_lowest"] = null;
			this.priceValues["tomorrow_highest"] = null;
			this.priceValues["tomorrow_avg"] = null;
		}
	} else {
		this.priceValues["today_prices"] = null;
		this.priceValues["today_lowest"] = null;
		this.priceValues["today_highest"] = null;
		this.priceValues["today_avg"] = null;
	}
	this.log("Mapped prices succesfully");
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
	date.setHours(date.getHours() + timeDifference);
	return date;
  }

  async fetchPricesFromApi(location, netCompany, product, redafg){
		this.log("Fetching prices from api");
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

	// FLOW TRIGGERS

	async newPricesReceivedTrigger() {
		const tokens = {
			"todays_price_lowest" : this.priceValues["today_lowest"] || 0,
			"todays_price_highest" : this.priceValues["today_highest"] || 0,
			"todays_price_avg" : this.priceValues["today_avg"] || 0,
			"tomorrow_price_lowest" : this.priceValues["tomorrow_lowest"] || 0,
			"tomorrow_price_highest" : this.priceValues["tomorrow_highest"] || 0,
			"tomorrow_price_avg" : this.priceValues["tomorrow_avg"] || 0
		}
		let state = {};
		this.driver.ready().then(() => {
			this.driver.triggerNewPricesReceivedFlow(this.device, tokens, state);
		});
	}

	async priceAvgTrigger() {
		const tokens = {
			"price_now": this.priceValues["h0"],
			"price_avg": this.priceValues["today_avg"]
		}
		let state = {};

		if (this.priceValues["h0"] > this.priceValues["today_avg"]){
			this.driver.ready().then(() => {
				this.driver.triggerPriceHigherAvgFlow(this.device, tokens, state);
			});
		}
		else if(this.priceValues["h0"] < this.priceValues["today_avg"]){
			this.driver.ready().then(() => {
				this.driver.triggerPriceLessAvgFlow(this.device, tokens, state);
			});
		}
	}

	async priceIsLowestHighestTrigger() {
		if (this.priceValues["today_prices"] != null){
			const date = this.getDanishTime();
			const index_low = this.priceValues["today_prices"].indexOf(this.priceValues["today_lowest"]);
			const index_high = this.priceValues["today_prices"].indexOf(this.priceValues["today_highest"]);

			const tokens = {
				"price_now" : this.priceValues["h0"] || 0,
			}
			let state = {};
			if (date.getHours() == index_low) {
				
				this.driver.ready().then(() => {
					this.driver.triggerPriceIsLowestFlow(this.device, tokens, state);
				});
			}
			else if (date.getHours() == index_high){
				this.driver.ready().then(() => {
					this.driver.triggerPriceIsHighestFlow(this.device, tokens, state);
				});
			}
		}
	}

	async priceIsNegativeTrigger() {
		if (this.priceValues["h0"] != null ) {
			if(this.priceValues["h0"] < 0) {
				const tokens = {
					"price_now" : this.priceValues["h0"] || 0,
				}
				let state = {};
				this.driver.ready().then(() => {
					this.driver.triggerPriceIsNegativeFlow(this.device, tokens, state);
				});
			}
		}
	}


	async priceLowestBetweenTrigger(){
		if (this.priceValues["h0"] != null){
			const tokens = {
				"price" : this.priceValues["h0"] || 0,
			}
			let state = {};
			this.driver.ready().then(() => {
				this.driver.triggerPriceLowestBetweenFlow(this.device, tokens, state);
			});
		}
	}

	async priceLowestBetween(args){
		const fromClock = args["from"];
		const toClock = args["to"];

		if (fromClock >= toClock){
			throw Error("From clock cant be greater or eqaul to clock");
		}

		const date = this.getDanishTime();
		const nowClock = date.getHours();
		const todaysPrices = this.priceValues["today_prices"];

		let lowValue = null;
		let lowIndex = null;
		for (let i = 0; i < todaysPrices.length; i++) {
			if (i < fromClock){
				continue;
			}
			else if (i > toClock){
				break;
			}
			else {
				if (lowValue == null || todaysPrices[i] < lowValue) {
					lowValue = todaysPrices[i];
					lowIndex = i;
				}
			}
		  }
		if(lowIndex == nowClock) {
			return true;
		}
		return false;
	}

	// AND CARDS
	async priceLessThanAvgCondition(args){
		if (this.priceValues["h0"] != null && this.priceValues["today_avg"] != null){
			return this.priceValues["h0"] < this.priceValues["today_avg"];
		}
		return false;
	}

	async priceHigherThanAvgCondition(args){
		if (this.priceValues["h0"] != null && this.priceValues["today_avg"] != null){
			return this.priceValues["h0"] > this.priceValues["today_avg"];
		}
		return false;
	}

	async priceOverValueCondition(args){
		if (this.priceValues["h0"] != null){
			return this.priceValues["h0"] > args["price"];
		}
		return false;
	}

	async priceUnderValueCondition(args){
		if (this.priceValues["h0"] != null){
			return this.priceValues["h0"] < args["price"];
		}
		return false;
	}
}


module.exports = MyDevice;
