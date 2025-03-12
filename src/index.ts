import axios from 'axios';
import {
  API, AccessoryPlugin, Logging, AccessoryConfig, Service,
  Characteristic as HomebridgeCharacteristic, CharacteristicValue,
} from 'homebridge';

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
  private informationService: Service;
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

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.service.getCharacteristic(Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTemperature.bind(this));

    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    this.informationService = new HomebridgeService.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'SleepMe')
      .setCharacteristic(Characteristic.Model, 'DockPro')
      .setCharacteristic(Characteristic.SerialNumber, 'Unknown')
      .setCharacteristic(Characteristic.FirmwareRevision, 'Unknown');

    this.fetchDeviceIdAndUpdateStatus();

    this.scheduleTimer = setInterval(() => this.checkSchedule(), 60000);
  }

  private async fetchDeviceIdAndUpdateStatus(): Promise<void> {
    try {
      const response = await axios.get('https://api.app.sleep.me/v1/devices', {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });

      const devices = response.data;

      if (!Array.isArray(devices) || devices.length === 0) {
        this.log.error('No devices found.');
        return;
      }

      this.deviceId = devices[0]?.id;
      if (!this.deviceId) {
        this.log.error('Device ID not found.');
        return;
      }

      this.log.info(`Using device ID: ${this.deviceId}`);
      await this.fetchDeviceDetailsAndUpdateStatus();
    } catch (error) {
      this.log.error('Error fetching devices:', error);
    }
  }

  private async fetchDeviceDetailsAndUpdateStatus(): Promise<void> {
    if (!this.deviceId) {
      this.log.error('Device ID is not set.');
      return;
    }

    try {
      const response = await axios.get(`https://api.app.sleep.me/v1/devices/${this.deviceId}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });

      this.firmwareVersion = response.data?.firmwareVersion || 'Unknown';
      this.log.info(`Firmware Version: ${this.firmwareVersion}`);
      this.informationService.setCharacteristic(Characteristic.FirmwareRevision, this.firmwareVersion || 'Unknown');

      await this.updateDeviceStatus();
    } catch (error) {
      this.log.error('Error fetching device details:', error);
    }
  }

  private async updateDeviceStatus(): Promise<void> {
    if (!this.deviceId) {
      this.log.error('Device ID is not set.');
      return;
    }

    try {
      const response = await axios.get<DeviceStatusResponse>(`https://api.app.sleep.me/v1/device/status/${this.deviceId}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });

      this.currentTemperature = response.data.temperature;
      this.targetTemperature = response.data.targetTemperature ?? this.targetTemperature;
      this.currentHeatingState = response.data.isHeating ? 1 : 0;
    } catch (error) {
      this.log.error('Error updating device status:', error);
    }
  }

  private async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    if (!this.deviceId) {
      this.log.error('Device ID is missing.');
      return;
    }

    const state = value as number;
    let mode;

    switch (state) {
    case 0: mode = 'off'; break;
    case 1: mode = 'heat'; break;
    case 2: mode = 'cool'; break;
    case 3: mode = 'auto'; break;
    default: this.log.error('Invalid mode'); return;
    }

    try {
      await axios.post(`https://api.app.sleep.me/v1/device/setMode/${this.deviceId}`, { mode }, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });

      this.currentHeatingState = state;
      this.log.info(`Mode set to: ${mode}`);
    } catch (error) {
      this.log.error('Error setting mode:', error);
    }
  }

  private getCurrentTemperature(): number {
    return this.currentTemperature;
  }

  private getTargetTemperature(): number {
    return this.targetTemperature;
  }

  private async setTemperature(value: CharacteristicValue): Promise<void> {
    if (!this.deviceId) {
      this.log.error('Device ID is missing.');
      return;
    }

    const targetTemp = value as number;

    try {
      await axios.post(`https://api.app.sleep.me/v1/device/setTemperature/${this.deviceId}`, { temperature: targetTemp }, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });

      this.targetTemperature = targetTemp;
      this.log.info(`Temperature set to ${targetTemp}°C`);
    } catch (error) {
      this.log.error('Error setting temperature:', error);
    }
  }

  private getCurrentHeatingCoolingState(): number {
    return this.currentHeatingState;
  }

  private getTargetHeatingCoolingState(): number {
    return this.currentHeatingState > 0 ? 1 : 0;
  }

  private getTemperatureDisplayUnits(): number {
    return this.unit === 'F' ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : Characteristic.TemperatureDisplayUnits.CELSIUS;
  }

  private setTemperatureDisplayUnits(units: CharacteristicValue): void {
    this.unit = units === Characteristic.TemperatureDisplayUnits.FAHRENHEIT ? 'F' : 'C';
  }

  private checkSchedule(): void {}

  getServices(): Service[] {
    return [this.informationService, this.service];
  }
}