/* eslint-disable @typescript-eslint/no-explicit-any */
import axios, { AxiosError } from 'axios';
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
  homebridge.registerAccessory('homebridge-sleepmepro', 'SleepMeAccessory', SleepMeAccessory);
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

  constructor(log: Logging, config: AccessoryConfig) {
    this.log = log;
    this.name = config.name;
    this.apiToken = config.apiToken;
    this.unit = config.unit || 'C';
    this.currentTemperature = 20;
    this.targetTemperature = 20;
    this.currentHeatingState = 0;

    this.service = new HomebridgeService.Thermostat(this.name);

    this.service.getCharacteristic(Characteristic.CurrentTemperature).onGet(() => this.currentTemperature);

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .onGet(() => this.targetTemperature)
      .onSet(this.setTemperature.bind(this));

    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).onGet(() => this.currentHeatingState);

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.currentHeatingState);

    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => (this.unit === 'F' ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : Characteristic.TemperatureDisplayUnits.CELSIUS));

    this.service.addCharacteristic(Characteristic.FirmwareRevision).onGet(() => this.firmwareVersion || 'Unknown');

    this.fetchDeviceIdAndUpdateStatus();

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
    this.log.debug(`[API Request] ${method} ${url}`);
    this.log.debug(`[API Headers] ${JSON.stringify(headers)}`);
    if (data) {
      this.log.debug(`[API Data] ${JSON.stringify(data)}`);
    }
  }

  private logAxiosResponse(method: string, url: string, response: any): void {
    this.log.debug(`[API Response] ${method} ${url}`);
    this.log.debug(`[API Status] ${response.status}`);
    this.log.debug(`[API Response Headers] ${JSON.stringify(response.headers)}`);
    this.log.debug(`[API Response Data] ${JSON.stringify(response.data)}`);
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

      this.logAxiosRequest('GET', url, headers);

      const response = await axios.get<Device[]>(url, { headers });

      this.logAxiosResponse('GET', url, response);

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
          this.log.error(`Error fetching devices: Status code ${axiosError.response.status}`);
          this.log.error(`Error data: ${JSON.stringify(axiosError.response.data)}`);
        } else if (axiosError.request) {
          this.log.error('Error fetching devices: No response received');
        } else {
          this.log.error('Error fetching devices:', axiosError.message);
        }
      } else {
        this.log.error('An unknown error occurred:', error);
      }
    }
  }
  private async updateDeviceStatus(): Promise<void> {
    if (!this.deviceId) {
      this.log.error('Device ID is missing.');
      return;
    }

    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}/status`;
      const headers = {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      };

      this.logAxiosRequest('GET', url, headers);

      const response = await axios.get<DeviceStatusResponse>(url, { headers });

      this.logAxiosResponse('GET', url, response);

      this.currentTemperature = response.data.status.water_temperature_c;
      this.targetTemperature = response.data.control.set_temperature_c;
      this.currentHeatingState = response.data.control.thermal_control_status === 'heating' ? 1 : 0;

      this.log.debug(
        `Status updated: Temp: ${this.currentTemperature}°C, Target: ${this.targetTemperature}°C, Heating: ${this.currentHeatingState}`,
      );
      // response is not returned because the function's return type is void
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.log.error(`Error updating device status: Status code ${axiosError.response.status}`);
          this.log.error(`Error data: ${JSON.stringify(axiosError.response.data)}`);
        } else if (axiosError.request) {
          this.log.error('Error updating device status: No response received');
        } else {
          this.log.error('Error updating device status:', axiosError.message);
        }
      } else {
        this.log.error('An unknown error occurred:', error);
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
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}/temperature`;
      const headers = {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      };
      const data = { targetTemperature: targetTemp };

      this.logAxiosRequest('PUT', url, headers, data);

      await this.rateLimitedApiCall(async () => {
        const response = await axios.put(url, { set_temperature_c: targetTemp }, { headers });

        this.logAxiosResponse('PUT', url, response);

        this.targetTemperature = targetTemp;
        this.log.info(`Temperature set to ${targetTemp}°C`);
      });
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.log.error(`Error setting temperature: Status code ${axiosError.response.status}`);
          this.log.error(`Error data: ${JSON.stringify(axiosError.response.data)}`);
        } else if (axiosError.request) {
          this.log.error('Error setting temperature: No response received');
        } else {
          this.log.error('Error setting temperature:', axiosError.message);
        }
      } else {
        this.log.error('An unknown error occurred:', error);
      }
    }
  }
}