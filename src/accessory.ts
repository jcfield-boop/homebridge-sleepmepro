/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Service, Characteristic, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform';
import axios, { AxiosResponse, AxiosError } from 'axios';

interface DeviceStatusResponse {
  status: {
    water_temperature_c: number;
  };
  control: {
    set_temperature_c: number;
    thermal_control_status: string;
  };
  about: {
    firmware_version: string;
  };
  // Add other properties as needed
}

export class SleepMeAccessory {
  private service: Service;
  private readonly deviceId: string;
  private currentTemperature = 0;
  private targetTemperature = 0;
  private currentHeatingState = 0;
  private firmwareVersion = 'Unknown';

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.deviceId = accessory.context.device.id;
    this.service = this.accessory.getService(platform.Service.Thermostat) || this.accessory.addService(platform.Service.Thermostat);
    this.service.setCharacteristic(platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.service.getCharacteristic(platform.Characteristic.TargetTemperature)
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(this.getTargetTemperature.bind(this));

    this.service.getCharacteristic(platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.service.getCharacteristic(platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.setTargetHeatingCoolingState.bind(this))
      .onGet(this.getTargetHeatingCoolingState.bind(this));

    this.getDeviceStatus();
    setInterval(() => this.getDeviceStatus(), 60000); // Update every minute
  }

  async getDeviceStatus() {
    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}`;
      const headers = {
        Authorization: `Bearer ${this.platform.config.apiToken}`,
        'Content-Type': 'application/json',
      };
      const response: AxiosResponse<DeviceStatusResponse> = await axios.get(url, { headers });
      this.currentTemperature = response.data.status.water_temperature_c;
      this.targetTemperature = response.data.control.set_temperature_c;
      this.currentHeatingState = response.data.control.thermal_control_status === 'heating' ? 1 : 0;
      this.firmwareVersion = response.data.about.firmware_version || 'Unknown';
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.currentTemperature);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.targetTemperature);
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, this.currentHeatingState);
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        this.platform.log.error(`API Error: ${error.message}`);
      } else {
        this.platform.log.error(`An unknown error occurred: ${error}`);
      }
    }
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.currentTemperature;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    return this.targetTemperature;
  }

  async setTargetTemperature(value: CharacteristicValue) {
    this.targetTemperature = value as number;
    // Implement API call to set target temperature
  }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.currentHeatingState;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.currentHeatingState;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    this.currentHeatingState = value as number;
    // Implement API call to set target heating/cooling state
  }

}