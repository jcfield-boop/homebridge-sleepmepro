import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform.js';
import { SleepMeApi } from './sleepme-api.js';

/**
 * SleepMe Humidity Sensor Accessory
 * Represents a humidity sensor from the SleepMe device
 */
export class HumidityAccessory {
  private service: Service;
  private batteryService: Service; // Added battery service for low water level
  private currentHumidity = 0;
  private lowWaterDetected = false;
  private deviceId: string;
  private isUpdating = false;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly apiService: SleepMeApi,
  ) {
    this.deviceId = this.accessory.context.device?.id || '';

    if (!this.deviceId) {
      this.platform.log.error('HumidityAccessory: Missing device ID');
    }

    // Set up the accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sleepme Inc.')
      .setCharacteristic(this.platform.Characteristic.Model, 'ChiliPad Humidity Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

    // Make sure we're using a HumiditySensor service, not Thermostat
    // Remove any existing Thermostat service if it exists (which might be causing the issue)
    const existingThermostat = this.accessory.getService(this.platform.Service.Thermostat);
    if (existingThermostat) {
      this.platform.log.debug('Removing incorrect Thermostat service from humidity sensor');
      this.accessory.removeService(existingThermostat);
    }

    // Set up the humidity sensor service (either use existing or create new)
    this.service = this.accessory.getService(this.platform.Service.HumiditySensor) || 
      this.accessory.addService(this.platform.Service.HumiditySensor, `${accessory.displayName}`);

    // Set up the battery service (to represent water level)
    this.batteryService = this.accessory.getService(this.platform.Service.Battery) ||
      this.accessory.addService(this.platform.Service.Battery, `${accessory.displayName} Water Level`);

    // Configure the battery service
    this.batteryService.setCharacteristic(this.platform.Characteristic.Name, `${accessory.displayName} Water Level`);
    
    // Register handlers for humidity characteristic
    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentHumidity.bind(this));

    // Register handlers for battery characteristics (representing water level)
    this.batteryService.getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(this.getWaterLevel.bind(this));
      
    this.batteryService.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(this.getLowWaterStatus.bind(this));
      
    this.batteryService.getCharacteristic(this.platform.Characteristic.ChargingState)
      .onGet(() => this.platform.Characteristic.ChargingState.NOT_CHARGING);

    // Initialize and set up polling if we have a valid device ID
    if (this.deviceId) {
      this.updateSensorData()
        .catch(error => this.platform.log.error(`Error initializing humidity sensor: ${error}`));

      // Set up periodic polling (60 seconds)
      setInterval(() => {
        this.updateSensorData()
          .catch(error => this.platform.log.error(`Error updating humidity sensor: ${error}`));
      }, 60000);
    }
  }

  /**
   * Get the current humidity value
   */
  async getCurrentHumidity(): Promise<CharacteristicValue> {
    this.platform.log.debug(`Returning current humidity: ${this.currentHumidity}%`);
    return this.currentHumidity;
  }
  
  /**
   * Get water level (simulated as battery level, 0-100%)
   * Returns 100% if no low water alert, 10% if low water detected
   */
  async getWaterLevel(): Promise<CharacteristicValue> {
    const level = this.lowWaterDetected ? 10 : 100;
    this.platform.log.debug(`Returning water level: ${level}%`);
    return level;
  }
  
  /**
   * Get low water status (represented as low battery in HomeKit)
   */
  async getLowWaterStatus(): Promise<CharacteristicValue> {
    const status = this.lowWaterDetected 
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    
    this.platform.log.debug(`Returning water level status: ${this.lowWaterDetected ? 'LOW' : 'NORMAL'}`);
    return status;
  }

  /**
   * Update the sensor data from the device (both humidity and water level)
   */
  async updateSensorData(): Promise<void> {
    if (this.isUpdating || !this.deviceId) {
      return;
    }

    this.isUpdating = true;
    try {
      this.platform.log.debug(`Updating sensor data for device ${this.deviceId}`);
      const deviceStatus = await this.apiService.getDeviceStatus(this.deviceId);
      
      if (!deviceStatus) {
        this.platform.log.error(`Failed to get status for device ${this.deviceId}`);
        return;
      }

      // Check if humidity is available in device status
      if (deviceStatus["status.humidity"] !== undefined) {
        const newHumidity = deviceStatus["status.humidity"];
        
        // Only update if changed
        if (newHumidity !== this.currentHumidity) {
          this.currentHumidity = newHumidity;
          
          // Update the characteristic
          this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentRelativeHumidity, 
            this.currentHumidity
          );
          
          this.platform.log.debug(`Updated humidity to ${this.currentHumidity}%`);
        }
      } else {
        this.platform.log.debug('Humidity data not available in device status');
      }
      
      // Check for water level status
      // Assuming the API returns a water level warning flag or status
      const waterWarning = deviceStatus["status.water_warning"] === true || 
                          deviceStatus["status.water_level_low"] === true ||
                          deviceStatus["status.water_level"] === "low";
      
      if (waterWarning !== this.lowWaterDetected) {
        this.lowWaterDetected = waterWarning;
        
        // Update battery characteristics
        this.batteryService.updateCharacteristic(
          this.platform.Characteristic.BatteryLevel,
          this.lowWaterDetected ? 10 : 100
        );
        
        this.batteryService.updateCharacteristic(
          this.platform.Characteristic.StatusLowBattery,
          this.lowWaterDetected 
            ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        );
        
        this.platform.log.info(`Updated water level status: ${this.lowWaterDetected ? 'LOW' : 'NORMAL'}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error updating sensor data: ${error.message}`);
      } else {
        this.platform.log.error(`Unknown error updating sensor data`);
      }
    } finally {
      this.isUpdating = false;
    }
  }
}