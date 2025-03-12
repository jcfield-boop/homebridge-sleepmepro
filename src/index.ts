import axios from 'axios';
import { API, AccessoryPlugin, Logging, AccessoryConfig, Service, Characteristic as HomebridgeCharacteristic, CharacteristicValue } from 'homebridge';

let HomebridgeService: typeof Service;
let Characteristic: typeof HomebridgeCharacteristic;

export default (homebridge: API): void => {
  HomebridgeService = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-sleepmepro', 'SleepMeAccessory', SleepMeAccessory);
};

interface DeviceStatusResponse {
  temperature: number;
  targetTemperature?: number;
  isHeating?: boolean;
  firmwareVersion?: string;
}

class SleepMeAccessory implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly name: string;
  private readonly apiToken: string;
  private unit: string;
  private currentTemperature: number;
  private targetTemperature: number;
  private currentHeatingState: number;
  private service: Service;
  private deviceId?: string;
  private firmwareVersion?: string;
  private scheduleTimer: NodeJS.Timeout | null;

  constructor(log: Logging, config: AccessoryConfig) {
    this.log = log;
    this.name = config.name;
    this.apiToken = config.apiToken;
    this.unit = config.unit || 'C'; // Default to Celsius
    this.currentTemperature = 20; // Default starting value
    this.targetTemperature = 20;  // Default starting value
    this.currentHeatingState = 0; // 0 = OFF, 1 = HEAT

    // Initialize the thermostat service
    this.service = new HomebridgeService.Thermostat(this.name);

    // Required characteristics
    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on('get', this.getCurrentTemperature.bind(this));

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .on('get', this.getTargetTemperature.bind(this))
      .onSet(this.setTemperature.bind(this));

    this.service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', this.getCurrentHeatingCoolingState.bind(this));

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on('get', this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .on('get', this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    // Add firmware version characteristic
    this.service.addCharacteristic(Characteristic.FirmwareRevision)
      .on('get', (callback) => {
        callback(null, this.firmwareVersion || 'Unknown');
      });

    // Fetch the device ID and update the status
    this.fetchDeviceIdAndUpdateStatus();

    // Initialize the schedule timer to check for schedule every minute
    this.scheduleTimer = setInterval(() => this.checkSchedule(), 60000); // Check every minute
  }

  private fetchDeviceIdAndUpdateStatus(): void {
    axios
      .get('https://api.app.sleep.me/v1/devices', {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      })
      .then((response) => {
        // Log the full response for debugging purposes
        this.log.debug('Devices fetched:', response.data);

        const devices = response.data;

        // Check if devices array is empty or malformed
        if (!Array.isArray(devices) || devices.length === 0) {
          this.log.error('No devices found in API response. Please check the API token or device configuration.');
          return;
        }

        // Use the first device (modify logic if you expect multiple devices)
        this.deviceId = devices[0]?.id;

        if (!this.deviceId) {
          this.log.error('Device ID not found in the first device response. Please check the API structure.');
          return;
        }

        this.log.info(`Using device ID: ${this.deviceId}`);

        // Fetch device details to get the firmware version
        this.fetchDeviceDetailsAndUpdateStatus();
      })
      .catch((error) => {
        this.log.error('Error fetching devices:', error.message);
        if (error.response) {
          this.log.debug('API response error:', error.response.status, error.response.data);

          // Handle authentication errors
          if (error.response.status === 401) {
            this.log.error('Authentication failed. Please check your API token.');
          }
        }
      });
  }

  private fetchDeviceDetailsAndUpdateStatus(): void {
    if (!this.deviceId) {
      this.log.error('Device ID is not set. Cannot fetch device details.');
      return;
    }

    axios
      .get(`https://api.app.sleep.me/v1/devices/${this.deviceId}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      })
      .then((response) => {
        // Log the full device details for debugging
        this.log.debug('Device details fetched:', response.data);

        const deviceDetails = response.data;

        // Parse the firmware version from the device details
        if (deviceDetails && deviceDetails.firmwareVersion) {
          this.firmwareVersion = deviceDetails.firmwareVersion;
          this.log.info(`Firmware Version: ${this.firmwareVersion}`);
        } else {
          this.log.warn('Firmware version not found in the device details.');
        }

        // Continue with the normal update of device status
        this.updateDeviceStatus();
      })
      .catch((error) => {
        this.log.error('Error fetching device details:', error.message);
        if (error.response) {
          this.log.debug('API response error:', error.response.status, error.response.data);

          // Handle authentication errors
          if (error.response.status === 401) {
            this.log.error('Authentication failed. Please check your API token.');
          }
        }
      });
  }

  private updateDeviceStatus(): void {
    if (!this.deviceId) {
      this.log.error('Device ID is not set. Cannot update device status.');
      return;
    }

    axios
      .get<DeviceStatusResponse>(`https://api.app.sleep.me/v1/device/status/${this.deviceId}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      })
      .then((response) => {
        this.currentTemperature = response.data.temperature;
        if (response.data.targetTemperature !== undefined) {
          this.targetTemperature = response.data.targetTemperature;
        }
        if (response.data.isHeating !== undefined) {
          this.currentHeatingState = response.data.isHeating ? 1 : 0;
        }
        this.log.debug(
          `Device status updated: Current temp: ${this.currentTemperature}°C, Target: ${this.targetTemperature}°C, Heating: ${this.currentHeatingState}`,
        );
      })
      .catch((error) => {
        this.log.error('Error updating device status:', error.message);
        if (error.response) {
          this.log.debug('API response error:', error.response.status, error.response.data);

          // Handle authentication errors
          if (error.response.status === 401) {
            this.log.error('Authentication failed. Please check your API token.');
          }
        }
      });
  }

  private getCurrentTemperature(callback: (error: Error | null, value?: number) => void): void {
    this.updateDeviceStatus(); // Refresh the status

    const temp = this.unit === 'F' ? this.celsiusToFahrenheit(this.currentTemperature) : this.currentTemperature;

    this.log.debug(`Getting current temperature: ${temp}°${this.unit}`);
    callback(null, this.currentTemperature); // HomeKit expects Celsius
  }

  private getTargetTemperature(callback: (error: Error | null, value?: number) => void): void {
    const temp = this.unit === 'F' ? this.celsiusToFahrenheit(this.targetTemperature) : this.targetTemperature;

    this.log.debug(`Getting target temperature: ${temp}°${this.unit}`);
    callback(null, this.targetTemperature); // HomeKit expects Celsius
  }

  private setTemperature(value: CharacteristicValue, callback: (error?: Error) => void): void {
    const targetTemp = value as number;
    const displayTemp = this.unit === 'F' ? this.celsiusToFahrenheit(targetTemp) : targetTemp;

    axios
      .post(
        `https://api.app.sleep.me/v1/device/setTemperature/${this.deviceId}`,
        {
          temperature: targetTemp,
        },
        {
          headers: { Authorization: `Bearer ${this.apiToken}` },
        },
      )
      .then(() => {
        this.targetTemperature = targetTemp;
        this.log.info(`Temperature set to ${displayTemp.toFixed(1)}°${this.unit}`);
        callback();
      })
      .catch((error) => {
        this.log.error('Error setting temperature:', error.message);
        callback(error);
      });
  }

  private getCurrentHeatingCoolingState(callback: (error: Error | null, value?: number) => void): void {
    callback(null, this.currentHeatingState);
  }

  private getTargetHeatingCoolingState(callback: (error: Error | null, value?: number) => void): void {
    callback(null, this.currentHeatingState > 0 ? 1 : 0);
  }

  private setTargetHeatingCoolingState(value: CharacteristicValue, callback: (error?: Error) => void): void {
    const state = value as number;
    this.log.info(`Set target heating state to: ${state}`);

    if (state === 0) {
      this.log.info('Sending off command to SleepMe device');
    } else if (state === 1) {
      this.log.info('Sending heat command to SleepMe device');
    }

    callback();
  }

  private getTemperatureDisplayUnits(callback: (error: Error | null, value?: number) => void): void {
    const units = this.unit === 'F' ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : Characteristic.TemperatureDisplayUnits.CELSIUS;
    callback(null, units);
  }

  private setTemperatureDisplayUnits(units: CharacteristicValue, callback: (error?: Error) => void): void {
    this.unit = units === Characteristic.TemperatureDisplayUnits.FAHRENHEIT ? 'F' : 'C';
    this.log.info(`Display units set to: ${this.unit}`);
    callback();
  }

  private checkSchedule(): void {
    // Your existing schedule check logic...
  }

  getServices(): Service[] {
    return [this.service];
  }

  // Clean up on shutdown
  shutdown(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  private celsiusToFahrenheit(celsius: number): number {
    return (celsius * 9) / 5 + 32;
  }
}
