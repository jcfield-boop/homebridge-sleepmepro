import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform.js';
import { SleepMeApi } from './sleepme-api.js';

/**
 * SleepMe Humidity Sensor Accessory
 * Represents a humidity sensor from the SleepMe device
 */
export class HumidityAccessory {
  private service: Service;
  private currentHumidity = 0;
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

    // Set up the accessory
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sleepme Inc.')
      .setCharacteristic(this.platform.Characteristic.Model, 'ChiliPad Humidity Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

    // Set up the humidity sensor service
    this.service = this.accessory.getService(this.platform.Service.HumiditySensor) || 
      this.accessory.addService(this.platform.Service.HumiditySensor, `${accessory.displayName} Humidity`);

    // Set primary service
    this.service.setPrimaryService(true);

    // Register handlers
    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentHumidity.bind(this));

    // Initialize and set up polling if we have a valid device ID
    if (this.deviceId) {
      this.updateHumidity()
        .catch(error => this.platform.log.error(`Error initializing humidity: ${error}`));

      // Set up periodic polling (60 seconds)
      setInterval(() => {
        this.updateHumidity()
          .catch(error => this.platform.log.error(`Error updating humidity: ${error}`));
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
   * Update the humidity value from the device
   */
  async updateHumidity(): Promise<void> {
    if (this.isUpdating || !this.deviceId) {
      return;
    }

    this.isUpdating = true;
    try {
      this.platform.log.debug(`Updating humidity for device ${this.deviceId}`);
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
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error updating humidity: ${error.message}`);
      } else {
        this.platform.log.error(`Unknown error updating humidity`);
      }
    } finally {
      this.isUpdating = false;
    }
  }
}