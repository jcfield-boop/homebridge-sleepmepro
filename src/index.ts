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
  temperature: number;
  targetTemperature?: number;
  isHeating?: boolean;
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
      .onGet(() => this.currentHeatingState)
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => (this.unit === 'F' ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : Characteristic.TemperatureDisplayUnits.CELSIUS));

    this.service.addCharacteristic(Characteristic.FirmwareRevision).onGet(() => this.firmwareVersion || 'Unknown');

    this.fetchDeviceIdAndUpdateStatus();

    this.scheduleTimer = setInterval(() => this.updateDeviceStatus(), 60000); //updated to call updateDeviceStatus
  }

  getServices(): Service[] {
    return [this.service];
  }

  private async fetchDeviceIdAndUpdateStatus(): Promise<void> {
    try {
      const response = await axios.get<Device[]>('https://api.developer.sleep.me/v1/devices', {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!Array.isArray(response.data) || response.data.length === 0) {
        this.log.error('No devices found.');
        return;
      }

      this.deviceId = response.data[0].id;
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
      const response = await axios.get<DeviceStatusResponse>(
        `https://api.developer.sleep.me/v1/device/status/${this.deviceId}`,
        {
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      this.currentTemperature = response.data.temperature;
      if (response.data.targetTemperature !== undefined) {
        this.targetTemperature = response.data.targetTemperature;
      }
      this.currentHeatingState = response.data.isHeating ? 1 : 0;

      this.log.debug(
        `Status updated: Temp: ${this.currentTemperature}°C, Target: ${this.targetTemperature}°C, Heating: ${this.currentHeatingState}`,
      );
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
      await axios.post(
        `https://api.developer.sleep.me/v1/device/setTemperature/${this.deviceId}`,
        {
          temperature: targetTemp,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      this.targetTemperature = targetTemp;
      this.log.info(`Temperature set to ${targetTemp}°C`);
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

  private async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    const state = value as number;
    this.currentHeatingState = state;
  }
}
