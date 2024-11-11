import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PandaPwrPlatform } from './platform.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class PandaPwrPlatformAccessory {
  private service: Service;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private pandaPwrStates = {
    On: false,
    Brightness: 100,
  };

  constructor(
    private readonly platform: PandaPwrPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panda')
      .setCharacteristic(this.platform.Characteristic.Model, 'PandaPwr')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'PandaPwrSerial');

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.exampleDisplayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this)) // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this)) // GET - bind to the `getOn` method below
      .setValue('PandaPwr');

    /**
     * Updating characteristics values asynchronously.
     *
     * Example showing how to update the state of a Characteristic asynchronously instead
     * of using the `on('get')` handlers.
     * Here we change update the motion sensor trigger states on and off every 10 seconds
     * the `updateCharacteristic` method.
     *
     */
    setInterval(() => {
      fetch(`http://${accessory.context.device.ip}/update_ele_data`).then((response) =>
        response.json().then(json => {
          this.pandaPwrStates.On = json.power !== 0;
          this.pandaPwrStates.Brightness = json.current * 100;
        }),
      ).catch(e => {
        this.platform.log.error(e);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      });
    }, 5000);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setOn(value: CharacteristicValue) {
    // implement your own code to turn your device on/off
    const state = value as boolean ? 1 : 0;
    this.pandaPwrStates.On = value as boolean;
    this.platform.log.debug('Set Characteristic On ->', value);
    fetch(`http://${this.accessory.context.device.ip}/set`, {
      'headers': {
        'cache-control': 'no-cache',
        'content-type': 'text/plain;charset=UTF-8',
        'pragma': 'no-cache',
      },
      'body': `power=${state}`,
      'method': 'POST',
      'mode': 'cors',
      'credentials': 'omit',
    }).then(response => {
      if (!response.ok) {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      this.platform.log.debug('Set Characteristic On Succeeded');
    }).catch(e => {
      this.platform.log.error(e);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possible. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.
   * In this case, you may decide not to implement `onGet` handlers, which may speed up
   * the responsiveness of your device in the Home app.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getOn(): Promise<CharacteristicValue> {
    // implement your own code to check if the device is on
    this.platform.log.debug('Get Characteristic On ->', this.pandaPwrStates.On);
    const data = await fetch(`http://${this.accessory.context.device.ip}/update_ele_data`);
    const json = await data.json();
    this.pandaPwrStates.On = json.power !== 0;
    return this.pandaPwrStates.On;
  }
}
