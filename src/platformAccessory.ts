import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform';
import { SleepMeApi } from './sleepme-api';

interface DeviceStatus {
  "control.target_temperature_c": number;
  "control.current_temperature_c": number;
  // Add other properties based on the API documentation
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SleepMePlatformAccessory {
  private service: Service;
  private targetTemperature: number;
  private currentTemperature!: number;
  private targetHeatingState = 0;
  private deviceId: string;
  private firmwareVersion!: string;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
    private apiService: SleepMeApi,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sleepme Inc.')
      .setCharacteristic(this.platform.Characteristic.Model, 'ChiliPad')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

    // get device ID
    this.deviceId = this.accessory.context.device.id;

    // get target temperature from cache
    if (this.accessory.context.device["control.target_temperature_c"] !== undefined) {
      this.targetTemperature = this.accessory.context.device["control.target_temperature_c"];
    } else {
      this.targetTemperature = 21;
    }

    // get firmware version from cache
    if (this.accessory.context.device.firmwareVersion) {
      this.firmwareVersion = this.accessory.context.device.firmwareVersion;
      this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.firmwareVersion);
    }

    // set the service name, this is what is displayed to the user
    this.service = this.accessory.getService(this.platform.Service.Thermostat) || this.accessory.addService(this.platform.Service.Thermostat);

    // register handlers for the Target Temperature Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(() => {
        return this.targetTemperature;
      });

    // register handlers for the Current Temperature Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    // register handlers for the Current Heating Cooling State Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    // register handlers for the Target Heating Cooling State Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onSet(this.setTargetHeaterCoolerState.bind(this));

    // Update device status periodically
    this.updateDeviceStatus();
    setInterval(() => {
      this.updateDeviceStatus();
    }, 30000);
  }

  async updateDeviceStatus() {
    try {
      const deviceId = this.accessory.context.device.id;
      this.platform.log.debug('Fetching device status from: ' + this.platform.apiService.baseUrl + '/devices/' + deviceId);
      const deviceStatus: DeviceStatus = await this.apiService.getDeviceStatus(deviceId);
      this.platform.log.debug('[API] GET ' + this.platform.apiService.baseUrl + '/devices/' + deviceId + ' - Status: 200');

      if (!deviceStatus) {
        this.platform.log.error('Unable to get device status');
        return;
      }
      // Access properties using the correct names from DeviceStatus
      if (deviceStatus["control.current_temperature_c"] !== undefined) {
        this.currentTemperature = deviceStatus["control.current_temperature_c"];
        this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature).updateValue(this.currentTemperature);
      }
      if (deviceStatus["control.target_temperature_c"] !== undefined) {
        this.targetTemperature = deviceStatus["control.target_temperature_c"];
        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).updateValue(this.targetTemperature);
      }

      this.platform.log.debug(`Updated device status: Temp=${this.currentTemperature}°C, Target=${this.targetTemperature}°C`);
    } catch (error: any) {
      this.platform.log.error('Error updating device status:', error);
    }
  }

  async setTargetTemperature(value: CharacteristicValue) {
    try {
      this.platform.log.debug('Set Target Temperature: ' + value);
      const deviceId = this.accessory.context.device.id;
      this.targetTemperature = value as number;
      await this.apiService.setDeviceSettings(deviceId, { "control.set_temperature_c": this.targetTemperature });
      this.platform.log('Successfully set target temperature: ' + this.targetTemperature);
    } catch (error: any) {
      this.platform.log.error('Error setting target temperature:', error.message);
    }
  }

  async setTargetHeaterCoolerState(value: CharacteristicValue) {
    try {
      this.platform.log.debug('Set Target Heater Cooler State: ' + value);
      const deviceId = this.accessory.context.device.id;

      let targetTemperature: number;

      switch (value) {
        case this.platform.Characteristic.TargetHeaterCoolerState.OFF:
          // Set to "off" temperature (e.g., current temperature)
          targetTemperature = this.getCurrentTemperature();
          this.platform.log.debug('Setting OFF ' + targetTemperature);
          break;
        case this.platform.Characteristic.TargetHeaterCoolerState.HEAT:
          // Set to a heating temperature (e.g., +2°C above current)
          targetTemperature = this.getCurrentTemperature() + 2;
          this.platform.log.debug('Setting HEAT ' + targetTemperature);
          break;
        case this.platform.Characteristic.TargetHeaterCoolerState.COOL:
          // Set to a cooling temperature (e.g., -2°C below current)
          targetTemperature = this.getCurrentTemperature() - 2;
          this.platform.log.debug('Setting COOL ' + targetTemperature);
          break;
        case this.platform.Characteristic.TargetHeaterCoolerState.AUTO:
          // In "Auto" mode, we primarily focus on setting the target temperature.
          // The device itself will decide whether to heat or cool based on its internal logic.
          targetTemperature = this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).value as number;
          this.platform.log.debug('Setting AUTO ' + targetTemperature);
          break;
        default:
          this.platform.log.warn(`Unexpected target heater cooler state value: ${value}`);
          return;
      }

      // Ensure targetTemperature is within the valid range (13.0-48.0)
      targetTemperature = Math.max(13.0, Math.min(48.0, targetTemperature));

      this.platform.log.debug(`Setting target temperature to ${targetTemperature}°C`);

      // Use setDeviceSettings instead of setTargetTemperature
      await this.apiService.setDeviceSettings(deviceId, {
        "control.set_temperature_c": targetTemperature,
      });
      this.platform.log('Successfully set target temperature: ' + targetTemperature);
    } catch (error: any) {
      this.platform.log.error('Error setting target heater cooler state:', error.message);
    }
  }

  getCurrentTemperature(): number {
    // Access the current temperature from the cache
    return this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature).value as number;
  }

  getCurrentHeatingCoolingState(): number {
    // Just return idle for now
    return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
  }
}