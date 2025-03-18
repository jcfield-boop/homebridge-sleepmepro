import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform.js';
import { SleepMeApi } from './sleepme-api.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SleepMePlatformAccessory {
  private service: Service;
  private targetTemperature = 21; // Default value
  private currentTemperature = 21; // Default value
  private currentHeatingState = 0;
  private targetHeatingState = 0;
  private deviceId: string;
  private firmwareVersion = 'Unknown';
  private isUpdating = false;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly apiService: SleepMeApi,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sleepme Inc.')
      .setCharacteristic(this.platform.Characteristic.Model, 'ChiliPad')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);

    // Get device ID
    this.deviceId = this.accessory.context.device.id;

    // Get device name (use override if available)
    let deviceName = this.accessory.context.device.name;
    if (this.platform.config.devices) {
      const override = this.platform.config.devices.find((d: { id: string }) => d.id === this.deviceId);
      if (override && override.name) {
        deviceName = override.name;
        this.platform.log.debug(`Using override name for device ${this.deviceId}: ${deviceName}`);
      }
    }

    // Set up the service
    this.service = this.accessory.getService(this.platform.Service.Thermostat) || 
      this.accessory.addService(this.platform.Service.Thermostat, deviceName);

    // Set name characteristic
    this.service.setCharacteristic(this.platform.Characteristic.Name, deviceName);

    // Configure temperature range (min, max, step)
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: 13.0,
        maxValue: 46.0,
        minStep: 0.5,
      })
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(this.getTargetTemperature.bind(this));

    // Register handlers for other required characteristics
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.setTargetHeatingCoolingState.bind(this))
      .onGet(this.getTargetHeatingCoolingState.bind(this));

    // Set temperature display units based on config
    const displayUnits = this.platform.config.unit === 'C' 
      ? this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS
      : this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .updateValue(displayUnits);

    // Initialize device status
    this.updateDeviceStatus()
      .catch(error => this.platform.log.error(`Error initializing device status: ${error}`));

    // Set up periodic polling
    setInterval(() => {
      this.updateDeviceStatus()
        .catch(error => this.platform.log.error(`Error updating device status: ${error}`));
    }, 30000); // Every 30 seconds
  }

  async updateDeviceStatus(): Promise<void> {
    if (this.isUpdating) {
      return;
    }

    this.isUpdating = true;
    try {
      this.platform.log.debug(`Updating status for device ${this.deviceId}`);
      const deviceStatus = await this.apiService.getDeviceStatus(this.deviceId);
      
      if (!deviceStatus) {
        this.platform.log.error(`Failed to get status for device ${this.deviceId}`);
        return;
      }

      // Update temperature values
      if (deviceStatus["control.current_temperature_c"] !== undefined) {
        this.currentTemperature = deviceStatus["control.current_temperature_c"];
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentTemperature, 
          this.currentTemperature
        );
      }
      
      if (deviceStatus["control.target_temperature_c"] !== undefined) {
        this.targetTemperature = deviceStatus["control.target_temperature_c"];
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetTemperature, 
          this.targetTemperature
        );
      }

      // Update heating/cooling state based on temperature difference
      if (this.targetTemperature > this.currentTemperature + 0.5) {
        this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
      } else if (this.targetTemperature < this.currentTemperature - 0.5) {
        this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
      } else {
        this.currentHeatingState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      }
      
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState, 
        this.currentHeatingState
      );

      this.platform.log.debug(
        `Updated device status: Current=${this.currentTemperature.toFixed(1)}°C, ` +
        `Target=${this.targetTemperature.toFixed(1)}°C, ` +
        `State=${this.getHeatingStateName(this.currentHeatingState)}`
      );
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error updating device status: ${error.message}`);
      } else {
        this.platform.log.error(`Unknown error updating device status`);
      }
    } finally {
      this.isUpdating = false;
    }
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.currentTemperature;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    return this.targetTemperature;
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    try {
      const newTemp = value as number;
      this.platform.log.debug(`Setting target temperature to ${newTemp}°C for device ${this.deviceId}`);
      
      await this.apiService.setDeviceSettings(this.deviceId, {
        "control.set_temperature_c": newTemp
      });
      
      this.targetTemperature = newTemp;
      this.platform.log.info(`Target temperature set to ${newTemp}°C for device ${this.deviceId}`);
      
      // If the device is currently OFF but we're setting a temperature, turn it ON
      if (this.targetHeatingState === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
        this.targetHeatingState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetHeatingCoolingState,
          this.targetHeatingState
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error setting target temperature: ${error.message}`);
      } else {
        this.platform.log.error('Unknown error setting target temperature');
      }
      throw error;
    }
  }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.currentHeatingState;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.targetHeatingState;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    try {
      const state = value as number;
      this.platform.log.debug(`Setting target heating state to ${this.getHeatingStateName(state)} for device ${this.deviceId}`);
      
      this.targetHeatingState = state;
      
      // Handle different states
      switch (state) {
        case this.platform.Characteristic.TargetHeatingCoolingState.OFF: {
          // Turn off the device
          await this.apiService.setDeviceSettings(this.deviceId, {
            "control.set_temperature_c": this.currentTemperature // Set to current temp to avoid heating/cooling
          });
          break;
        }
          
        case this.platform.Characteristic.TargetHeatingCoolingState.HEAT: {
          // Set to heating mode (target > current)
          const heatingTemp = Math.max(this.currentTemperature + 2, this.targetTemperature);
          await this.apiService.setDeviceSettings(this.deviceId, {
            "control.set_temperature_c": heatingTemp
          });
          this.targetTemperature = heatingTemp;
          this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            this.targetTemperature
          );
          break;
        }
          
        case this.platform.Characteristic.TargetHeatingCoolingState.COOL: {
          // Set to cooling mode (target < current)
          const coolingTemp = Math.min(this.currentTemperature - 2, this.targetTemperature);
          await this.apiService.setDeviceSettings(this.deviceId, {
            "control.set_temperature_c": coolingTemp
          });
          this.targetTemperature = coolingTemp;
          this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            this.targetTemperature
          );
          break;
        }
          
        case this.platform.Characteristic.TargetHeatingCoolingState.AUTO: {
          // Just use the current target temperature
          await this.apiService.setDeviceSettings(this.deviceId, {
            "control.set_temperature_c": this.targetTemperature
          });
          break;
        }
      }
      
      this.platform.log.info(
        `Set heating state to ${this.getHeatingStateName(state)} for device ${this.deviceId}`
      );
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error setting target heating state: ${error.message}`);
      } else {
        this.platform.log.error('Unknown error setting target heating state');
      }
      throw error;
    }
  }

  // Helper function to get readable state name
  private getHeatingStateName(state: number): string {
    switch (state) {
      case this.platform.Characteristic.CurrentHeatingCoolingState.OFF:
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
        return 'OFF';
      case this.platform.Characteristic.CurrentHeatingCoolingState.HEAT:
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        return 'HEAT';
      case this.platform.Characteristic.CurrentHeatingCoolingState.COOL:
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
        return 'COOL';
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        return 'AUTO';
      default:
        return `UNKNOWN(${state})`;
    }
  }
}