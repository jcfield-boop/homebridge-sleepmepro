import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform.js';
import { SleepMeApi } from './sleepme-api.js';

export class SleepMePlatformAccessory {
  private service: Service;
  private readonly deviceId: string;
  private currentTemperature = 0;
  private targetTemperature = 0;
  private currentHeatingState = 0;
  private targetHeatingState = 0;
  private firmwareVersion = 'Unknown';
  private displayUnit: string;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly apiService: SleepMeApi,
  ) {
    this.deviceId = accessory.context.device.deviceId;
    this.displayUnit = platform.config.unit || 'C';
    
    // Set up accessory information
    const accessoryInfo = this.accessory.getService(this.platform.Service.AccessoryInformation);
    if (accessoryInfo) {
      accessoryInfo
        .setCharacteristic(this.platform.Characteristic.Manufacturer, 'SleepMe')
        .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.model || 'Unknown')
        .setCharacteristic(this.platform.Characteristic.SerialNumber, this.deviceId)
        .setCharacteristic(this.platform.Characteristic.FirmwareRevision, accessory.context.device.firmwareVersion || 'Unknown');
    }

    // Set up the thermostat service
    this.service = this.accessory.getService(this.platform.Service.Thermostat) ||
                   this.accessory.addService(this.platform.Service.Thermostat);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // Set up characteristic handlers
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: 10,
        maxValue: 46,
        minStep: 0.5,
      })
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(this.getTargetTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.setTargetHeatingCoolingState.bind(this))
      .onGet(this.getTargetHeatingCoolingState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    // Get initial device status
    this.updateDeviceStatus()
      .catch(error => this.platform.log.error(`Error initializing device status: ${error}`));
    
    // Set up polling interval
    setInterval(() => {
      this.updateDeviceStatus()
        .catch(error => this.platform.log.error(`Error updating device status: ${error}`));
    }, 60000); // Update every minute
  }

  async updateDeviceStatus(): Promise<void> {
    try {
      const deviceStatus = await this.apiService.getDeviceStatus(this.deviceId);
      
      if (!deviceStatus || !deviceStatus.status) {
        this.platform.log.error(`Failed to get status for device ${this.deviceId}`);
        return;
      }
      
      // Update temperature values (always stored internally in Celsius)
      if (deviceStatus.status.currentTemperature !== undefined) {
        this.currentTemperature = deviceStatus.status.currentTemperature;
      }
      
      if (deviceStatus.status.targetTemperature !== undefined) {
        this.targetTemperature = deviceStatus.status.targetTemperature;
      }
      
      // Update heating/cooling state
      if (deviceStatus.status.heatingCoolingState !== undefined) {
        const state = this.mapSleepMeStatusToHomeKit(deviceStatus.status.heatingCoolingState);
        this.currentHeatingState = state;
        this.targetHeatingState = state;
      }
      
      // Update firmware version if available
      if (deviceStatus.firmwareVersion) {
        this.firmwareVersion = deviceStatus.firmwareVersion;
        
        const accessoryInfo = this.accessory.getService(this.platform.Service.AccessoryInformation);
        if (accessoryInfo) {
          accessoryInfo.updateCharacteristic(this.platform.Characteristic.FirmwareRevision, this.firmwareVersion);
        }
      }
      
      // Update HomeKit characteristics
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature, 
        this.currentTemperature
      );
      
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetTemperature, 
        this.targetTemperature
      );
      
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState, 
        this.currentHeatingState
      );
      
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetHeatingCoolingState, 
        this.targetHeatingState
      );
      
      this.platform.log.debug(
        `Updated device status: Temp=${this.currentTemperature}°C, ` + 
        `Target=${this.targetTemperature}°C, ` + 
        `State=${deviceStatus.status.heatingCoolingState || 'unknown'}`
      );
    } catch (error) {
      this.platform.log.error(`Failed to update device status: ${error}`);
    }
  }

  private mapSleepMeStatusToHomeKit(status: string): number {
    switch (status?.toLowerCase()) {
      case 'heating':
        return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
      case 'cooling':
        return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
      default:
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.currentTemperature;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    return this.targetTemperature;
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    this.targetTemperature = value as number;
    
    try {
      await this.apiService.setTargetTemperature(this.deviceId, this.targetTemperature);
      this.platform.log.info(`Set target temperature to ${this.targetTemperature}°C for ${this.accessory.displayName}`);
    } catch (error) {
      this.platform.log.error(`Failed to set target temperature: ${error}`);
    }
  }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.currentHeatingState;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.targetHeatingState;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    this.targetHeatingState = value as number;
    
    try {
      await this.apiService.setHeatingCoolingState(this.deviceId, this.targetHeatingState);
      this.platform.log.info(`Set heating/cooling state to ${this.targetHeatingState} for ${this.accessory.displayName}`);
    } catch (error) {
      this.platform.log.error(`Failed to set heating/cooling state: ${error}`);
    }
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    return this.displayUnit === 'F'
      ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue): Promise<void> {
    // Store the user preference
    this.displayUnit = value as number === this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      ? 'F'
      : 'C';
    
    this.platform.log.debug(`Temperature display unit set to ${this.displayUnit}`);
  }
}