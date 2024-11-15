import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { PandaPwrPlatform } from './platform.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class PandaPwrPlatformAccessory {
  private service: Service;
  private voltageService: Service; // Added service for voltage
  private lastExecutionTime: number;

  private pandaPwrStates = {
    On: false,
    Voltage: 0,
  };

  constructor(
      private readonly platform: PandaPwrPlatform,
      private readonly accessory: PlatformAccessory,
  ) {
    this.lastExecutionTime = 0;
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panda')
      .setCharacteristic(this.platform.Characteristic.Model, 'PandaPwr')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'PandaPwrSerial');

    // get the Switch service (or create one if it doesn't exist)
    this.service = this.accessory.getService(this.platform.Service.Switch) || this.accessory.addService(this.platform.Service.Switch);

    // set the service name
    this.service.setCharacteristic(this.platform.Characteristic.Name, 'Panda-PWR');

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this)) // SET - bind to the `setOn` method
      .onGet(this.getOn.bind(this)); // GET - bind to the `getOn` method

    // Add the voltage service using the "CurrentTemperature" characteristic
    // (this will act as a proxy for voltage, adjust if needed)
    this.voltageService = this.accessory.getService('Voltage') || this.accessory.addService(this.platform.Service.TemperatureSensor, 'Voltage');
    this.voltageService.setCharacteristic(this.platform.Characteristic.Name, 'Panda Voltage')
      .setCharacteristic(this.platform.Characteristic.CurrentTemperature, this.pandaPwrStates.Voltage);

    // Update states asynchronously every interval
    setInterval(async () => {
      try {
        this.platform.log.debug('Getting PandaPwr state...');
        const response = await fetch(`http://${accessory.context.device.ip}/update_ele_data`);
        const json = await response.json();

        // Update power state
        this.pandaPwrStates.On = json.power !== 0;
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.pandaPwrStates.On);

        // Update voltage state
        this.pandaPwrStates.Voltage = json.current || 0;
        this.voltageService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.pandaPwrStates.Voltage);

        this.platform.log.debug('Updated PandaPwr state, power:', this.pandaPwrStates.On, 'voltage:', this.pandaPwrStates.Voltage);
      } catch (e) {
        this.platform.log.error(e as string);
      }
    }, this.accessory.context.device.interval * 1000);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setOn(value: CharacteristicValue) {
    const currentTime = Date.now();
    const timeSinceLastCall = currentTime - this.lastExecutionTime;

    // Check if at least 5 seconds (5000 milliseconds) have passed
    if (timeSinceLastCall < 5000) {
      this.platform.log.debug('Skipping setOn: Less than 5 seconds since the last call.');
      this.service.updateCharacteristic(this.platform.Characteristic.On,
        new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY));
      return;
    }
    this.lastExecutionTime = currentTime;

    const state = value as boolean ? 1 : 0;
    this.pandaPwrStates.On = value as boolean;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.pandaPwrStates.On);
    this.platform.log.debug('Set Characteristic On ->', value);
    // Send power command to the device
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
        this.pandaPwrStates.On = !this.pandaPwrStates.On;
        this.platform.log.error('Failed to set characteristic', state);
      }
      this.platform.log.debug('Set Characteristic On Succeeded', state);
    }).catch(e => {
      this.platform.log.error(e);
    });
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory.
   */
  async getOn(): Promise<CharacteristicValue> {
    this.platform.log.debug('Get Characteristic On ->', this.pandaPwrStates.On);
    return this.pandaPwrStates.On;
  }
}
