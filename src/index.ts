/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import axios, { AxiosError, AxiosResponse } from 'axios';
import {
  API,
  AccessoryPlugin,
  Logging,
  AccessoryConfig,
  Service,
  Characteristic as HomebridgeCharacteristic,
  CharacteristicValue,
} from 'homebridge';

let HomebridgeService: typeof Service;
let Characteristic: typeof HomebridgeCharacteristic;

export default (homebridge: API): void => {
  HomebridgeService = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory('homebridge-sleepmepro', 'sleepmepro', SleepMeAccessory);
};

interface Device {
  id: string;
  firmwareVersion?: string;
}

interface DeviceStatusResponse {
  about: {
    firmware_version: string;
    ip_address: string;
    lan_address: string;
    mac_address: string;
    model: string;
    serial_number: string;
  };
  control: {
    brightness_level: number;
    display_temperature_unit: string;
    set_temperature_c: number;
    set_temperature_f: number;
    thermal_control_status: string;
    time_zone: string;
  };
  status: {
    is_connected: boolean;
    is_water_low: boolean;
    water_level: number;
    water_temperature_f: number;
    water_temperature_c: number;
  };
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
  private requestCount: number;
  private minuteStart: number;
  private temperatureSchedule: any[];

  constructor(log: Logging, config: AccessoryConfig) {
    this.log = log;
    this.log.debug('SleepMeAccessory constructor called');
    this.name = config.name;
    this.apiToken = config.apiToken;
    this.unit = config.unit || 'C';
    this.currentTemperature = 20;
    this.targetTemperature = 20;
    this.currentHeatingState = 0;
    this.temperatureSchedule = config.temperatureSchedule || [];

    this.service = new HomebridgeService.Thermostat(this.name);

    this.service.getCharacteristic(Characteristic.CurrentTemperature).onGet(() => this.currentTemperature);

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .onGet(() => this.targetTemperature)
      .onSet(async (value: CharacteristicValue) => {
        await this.setTemperature(value);
      });

    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).onGet(() => this.currentHeatingState);

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.currentHeatingState);

    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => (this.unit === 'F' ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : Characteristic.TemperatureDisplayUnits.CELSIUS));

    this.service.addCharacteristic(Characteristic.FirmwareRevision).onGet(() => this.firmwareVersion || 'Unknown');

    this.fetchDeviceIdAndUpdateStatus();
    this.scheduleWarmUpEvents();

    this.scheduleTimer = setInterval(() => {
      try {
        this.updateDeviceStatus();
      } catch (error) {
        this.log.error('Error during scheduled device update:', error);
      }
    }, 60000);

    this.requestCount = 0;
    this.minuteStart = Math.floor(Date.now() / 60000);
  }

  getServices(): Service[] {
    return [this.service];
  }
  private logAxiosRequest(method: string, url: string, headers: any, data?: any): void {
    // No logging for successful requests
  }

  private logAxiosResponse(method: string, url: string, response: AxiosResponse): void {
    if (response.status >= 400) {
      this.log.error(`[API Error] ${method} - Status: ${response.status}`);
    }
  }

  private async rateLimitedApiCall<T>(apiCall: () => Promise<T>): Promise<T> {
    const currentMinute = Math.floor(Date.now() / 60000);

    if (currentMinute > this.minuteStart) {
      // New minute, reset counters
      this.minuteStart = currentMinute;
      this.requestCount = 0;
    }

    if (this.requestCount >= 10) {
      // Rate limit reached, wait until the next minute
      const delay = (this.minuteStart + 1) * 60000 - Date.now();
      this.log.debug(`Rate limit reached, waiting ${delay}ms`);
      await new Promise<void>(resolve => setTimeout(resolve, delay));

      // Reset counters after waiting
      this.minuteStart++;
      this.requestCount = 0;
    }

    this.requestCount++;
    return apiCall();
  }

  private async fetchDeviceIdAndUpdateStatus(): Promise<void> {
    try {
      const url = 'https://api.developer.sleep.me/v1/devices';
      const headers = {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      };

      // No logging for successful requests

      const response = await axios.get<Device[]>(url, { headers });

      this.logAxiosResponse('GET', url, response); // Log only errors

      if (!Array.isArray(response.data) || response.data.length === 0) {
        this.log.error('No devices found.');
        return;
      }

      this.deviceId = response.data[0].id.trim();
      this.firmwareVersion = response.data[0].firmwareVersion || 'Unknown';

      this.log.info(`Using device ID: ${this.deviceId}, Firmware: ${this.firmwareVersion}`);

      await this.updateDeviceStatus();
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.log.error(`[API Error] GET ${URL} - Status: ${axiosError.response.status}`);
          this.log.error(`[API Error Headers] ${JSON.stringify(axiosError.response.headers)}`);
          this.log.error(`[API Error Data] ${JSON.stringify(axiosError.response.data)}`);
        } else if (axiosError.request) {
          this.log.error(`[API Error] GET ${URL} - No response received`);
        } else {
          this.log.error(`[API Error] GET ${URL} - ${axiosError.message}`);
        }
      } else {
        this.log.error(`[API Error] GET ${URL} - An unknown error occurred: ${error}`);
      }
    }
  } 
  private async updateDeviceStatus(): Promise<void> {
    if (!this.deviceId) {
      this.log.error('Device ID is missing.');
      return;
    }
  
    try {
      const encodedDeviceId = encodeURIComponent(this.deviceId);
      const url = `https://api.developer.sleep.me/v1/devices/${encodedDeviceId}`; // Removed /status
      const headers = {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      };
  
      this.log.debug(`Constructed URL: ${url}`);
  
      const response = await axios.get<DeviceStatusResponse>(url, { headers });
  
      this.logAxiosResponse('GET', url, response);
  
      // Assuming the response structure is the same, adjust accordingly
      this.currentTemperature = response.data.status.water_temperature_c;
      this.targetTemperature = response.data.control.set_temperature_c;
      this.currentHeatingState = response.data.control.thermal_control_status === 'heating' ? 1 : 0;
  
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.log.error(`[API Error] GET ${URL} - Status: ${axiosError.response.status}`);
          this.log.error(`[API Error Headers] ${JSON.stringify(axiosError.response.headers)}`);
          this.log.error(`[API Error Data] ${JSON.stringify(axiosError.response.data)}`);
        } else if (axiosError.request) {
          this.log.error(`[API Error] GET ${URL} - No response received`);
        } else {
          this.log.error(`[API Error] GET ${URL} - ${axiosError.message}`);
        }
      } else {
        this.log.error(`[API Error] GET ${URL} - An unknown error occurred: ${error}`);
      }
    }
  }
  private async setTemperature(value: CharacteristicValue): Promise<void> {
    const targetTemp = value as number;
    if (!this.deviceId) {
      this.log.error('Cannot set temperature, device ID is missing.');
      return;
    }

    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}/control`;
      const headers = {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      };
      const data = { set_temperature_c: targetTemp, brightness_level: 100, thermal_control_status: 'heating' };

      this.logAxiosRequest('PATCH', url, headers, data); // Changed to PATCH

      await this.rateLimitedApiCall(async () => {
        const response = await axios.patch(url, data, { headers }); // Changed to patch

        this.logAxiosResponse('PATCH', url, response); // Changed to PATCH

        this.targetTemperature = targetTemp;
        this.log.info(`Temperature set to ${targetTemp}°C`);
      });
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.log.error(`[API Error] PATCH ${URL} - Status: ${axiosError.response.status}`);
          this.log.error(`[API Error Headers] ${JSON.stringify(axiosError.response.headers)}`);
          this.log.error(`[API Error Data] ${JSON.stringify(axiosError.response.data)}`);
        } else if (axiosError.request) {
          this.log.error(`[API Error] PATCH ${URL} - No response received`);
        } else {
          this.log.error(`[API Error] PATCH ${URL} - ${axiosError.message}`);
        }
      } else {
        this.log.error(`[API Error] PATCH ${URL} - An unknown error occurred: ${error}`);
      }
    }
  }

  private scheduleWarmUpEvents(): void {
    if (!this.temperatureSchedule || this.temperatureSchedule.length === 0) {
      return;
    }

    this.temperatureSchedule.forEach((scheduleItem) => {
      if (scheduleItem.warmAwakeSettings && scheduleItem.warmAwakeSettings.warmUpEnabled) {
        const [hours, minutes] = scheduleItem.time.split(':').map(Number);
        const now = new Date();
        const scheduleTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
        if (scheduleTime < now) {
          scheduleTime.setDate(scheduleTime.getDate() + 1); // Schedule for tomorrow if time is in the past
        }

        const warmUpStartTime = new Date(scheduleTime.getTime() - scheduleItem.warmAwakeSettings.warmUpDuration * 60000);
        const delay = warmUpStartTime.getTime() - now.getTime();

        if (delay > 0) {
          setTimeout(async () => {
            this.log.info(`Starting warm-up for ${this.name} at ${warmUpStartTime.toLocaleTimeString()}`);
            await this.warmUpDevice(scheduleItem.warmAwakeSettings.warmUpTemperature);
          }, delay);
        }
      }
    });
  }

  private async warmUpDevice(temperature: number): Promise<void> {
    if (!this.deviceId) {
      this.log.error('Cannot warm up, device ID is missing.');
      return;
    }

    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}/control`;
      const headers = {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      };
      const data = { set_temperature_c: temperature, brightness_level: 100, thermal_control_status: 'heating' };

      this.logAxiosRequest('PATCH', url, headers, data); // Changed to PATCH

      await this.rateLimitedApiCall(async () => {
        const response = await axios.patch(url, data, { headers }); // Changed to patch

        this.logAxiosResponse('PATCH', url, response); // Changed to PATCH

        this.log.info(`Warmed up ${this.name} to ${temperature}°C`);
      });
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.log.error(`[API Error] PATCH ${URL} - Status: ${axiosError.response.status}`);
          this.log.error(`[API Error Headers] ${JSON.stringify(axiosError.response.headers)}`);
          this.log.error(`[API Error Data] ${JSON.stringify(axiosError.response.data)}`);
        } else if (axiosError.request) {
          this.log.error(`[API Error] PATCH ${URL} - No response received`);
        } else {
          this.log.error(`[API Error] PATCH ${URL} - ${axiosError.message}`);
        }
      } else {
        this.log.error(`[API Error] PATCH ${URL} - An unknown error occurred: ${error}`);
      }
    }
  }
}